import { getTranslator, type Translator } from "../../../i18n";
import type { ClientInputEvent } from "../../../types";

export interface ProgressRendererOptions {
  /** Number of recent progress lines to keep before collapsing older ones. Defaults to 10. */
  collapseThreshold?: number;
  t?: Translator;
  /**
   * Rendering style.
   *
   * - `log` (default): one markdown line per tool event, tool names included.
   * - `steps`: a single semantic step line ("running a command"), with no tool
   *   names, arguments or history. Used by channels whose bubble should read as
   *   a status line rather than as a build log.
   */
  mode?: ProgressRendererMode;
}

export type ProgressRendererMode = "log" | "steps";

/** The subset of `ClientInputEvent` that represents a renderable progress update. */
export type ProgressEvent = Extract<
  ClientInputEvent,
  | { type: "session.compacting" }
  | { type: "assistant.tool.running" }
  | { type: "assistant.tool.update" }
  | { type: "assistant.tool.done" }
  | { type: "assistant.tool.error" }
>;

type ToolProgressEvent = Exclude<ProgressEvent, { type: "session.compacting" }>;

export interface RenderedProgress {
  markdown: string;
  status: string;
  collapsedCount: number;
  isEmpty: boolean;
}

const DEFAULT_COLLAPSE_THRESHOLD = 10;
const MAX_TOOL_LABEL_DISPLAY_LENGTH = 24;

/**
 * Tool families behind the `steps` mode wording. Matched on the lowercased tool
 * name, exact first and then by prefix so `lsp_hover`, `mcp_jenkins__*` and
 * friends still land on a sensible family.
 */
const STEP_KEY_BY_TOOL_NAME: Record<string, string> = {
  bash: "progress.steps.command",
  shell: "progress.steps.command",
  exec: "progress.steps.command",
  terminal: "progress.steps.command",
  run_command: "progress.steps.command",
  execute: "progress.steps.command",
  read: "progress.steps.read",
  read_file: "progress.steps.read",
  ls: "progress.steps.read",
  list: "progress.steps.read",
  find: "progress.steps.read",
  glob: "progress.steps.read",
  write: "progress.steps.write",
  write_file: "progress.steps.write",
  edit: "progress.steps.write",
  multi_edit: "progress.steps.write",
  apply_patch: "progress.steps.write",
  grep: "progress.steps.search",
  search: "progress.steps.search",
  ripgrep: "progress.steps.search",
  web_search: "progress.steps.fetch",
  fetch_content: "progress.steps.fetch",
  fetch: "progress.steps.fetch",
  web_fetch: "progress.steps.fetch",
  browser: "progress.steps.fetch",
};

const STEP_KEY_BY_TOOL_PREFIX: Array<[prefix: string, key: string]> = [
  ["lsp_", "progress.steps.read"],
  ["read_", "progress.steps.read"],
  ["get_", "progress.steps.read"],
  ["list_", "progress.steps.read"],
  ["write_", "progress.steps.write"],
  ["edit_", "progress.steps.write"],
  ["search_", "progress.steps.search"],
  ["find_", "progress.steps.search"],
  ["web_", "progress.steps.fetch"],
  ["fetch_", "progress.steps.fetch"],
  ["run_", "progress.steps.command"],
  ["exec_", "progress.steps.command"],
];

function stepKeyForToolName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  const exact = STEP_KEY_BY_TOOL_NAME[normalized];
  if (exact) {
    return exact;
  }
  for (const [prefix, key] of STEP_KEY_BY_TOOL_PREFIX) {
    if (normalized.startsWith(prefix)) {
      return key;
    }
  }
  return "progress.steps.generic";
}

/**
 * Accumulates agent progress events (tool running/done/error, session
 * compacting, ...) for a single conversation turn and renders them as a
 * markdown string. One instance tracks one turn's worth of progress;
 * callers should create a fresh instance when a new turn starts.
 */
type ProgressEntry =
  | {
      kind: "line";
      line: string;
    }
  | {
      kind: "tool";
      toolName: string;
      toolLabel?: string;
      status: "running" | "done" | "error";
      text?: string;
    };

export class ProgressRenderer {
  readonly #collapseThreshold: number;
  readonly #t: Translator;
  readonly #mode: ProgressRendererMode;
  #entries = new Map<string, ProgressEntry>();
  #order: string[] = [];
  #status = "running";
  #stepSubject: string | null = null;
  #stepCount = 0;
  #stepFailed = false;

  constructor(options: ProgressRendererOptions = {}) {
    this.#collapseThreshold = options.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
    this.#t = options.t ?? getTranslator("en-US");
    this.#mode = options.mode ?? "log";
  }

  /**
   * Whether `event` should be recorded as progress (excludes assistant messages,
   * thinking, streaming deltas and run settlement — those are answer content,
   * not progress lines).
   */
  isProgressEvent(event: ClientInputEvent): event is ProgressEvent {
    return (
      event.type !== "assistant.message" &&
      event.type !== "assistant.thinking" &&
      event.type !== "assistant.delta" &&
      event.type !== "agent.run.settled"
    );
  }

  /** Records a progress event, formatting it into a line and collapsing older lines if needed. */
  takeProgressEvent(event: ProgressEvent): void {
    if (this.#mode === "steps") {
      this.#stepCount += 1;
      this.#stepSubject = this.#stepSubjectFor(event);
      this.#stepFailed = event.type === "assistant.tool.error";
      this.#status = this.#progressStatus(event);
      return;
    }

    if (this.#isToolProgressEvent(event)) {
      const toolEntryId = this.#toolEntryId(event);
      if (toolEntryId) {
        this.#upsertToolEntry(toolEntryId, event);
      } else {
        this.#appendLineEntry(this.#formatProgressLine(event));
      }
    } else {
      this.#appendLineEntry(this.#formatProgressLine(event));
    }
    this.#status = this.#progressStatus(event);
  }

  /** Returns the current rendered markdown, status, and collapsed-line count. */
  getCurrentProgress(): RenderedProgress {
    if (this.#mode === "steps") {
      const isEmpty = this.#stepCount === 0;
      return {
        markdown: isEmpty ? this.#t("progress.noProgress") : this.#currentStepLine(),
        status: this.#status,
        collapsedCount: 0,
        isEmpty,
      };
    }

    const collapsedCount = Math.max(0, this.#order.length - this.#collapseThreshold);
    return {
      markdown: this.#renderMarkdown(collapsedCount),
      status: this.#status,
      collapsedCount,
      isEmpty: this.#order.length === 0,
    };
  }

  #renderMarkdown(collapsedCount: number): string {
    const contentLines: string[] = [];
    if (collapsedCount > 0) {
      contentLines.push(`- ${this.#t("progress.collapsed", { count: collapsedCount })}`);
    }
    for (const id of this.#visibleOrder()) {
      const entry = this.#entries.get(id);
      if (!entry) continue;
      contentLines.push(entry.kind === "line" ? entry.line : this.#formatToolEntry(entry));
    }
    return contentLines.length > 0 ? contentLines.join("\n") : this.#t("progress.noProgress");
  }

  #visibleOrder(): string[] {
    return this.#order.slice(-this.#collapseThreshold);
  }

  /** The single line a `steps`-mode bubble shows: the step in flight, or a failure note. */
  #currentStepLine(): string {
    if (this.#stepFailed) {
      return this.#t("progress.steps.failed");
    }
    return this.#stepSubject ?? this.#t("progress.steps.generic");
  }

  /**
   * Maps a progress event onto a user-facing step description. Tool names,
   * arguments and results stay out of it on purpose: the bubble reports what
   * the agent is doing, not which tool it reached for.
   */
  #stepSubjectFor(event: ProgressEvent): string {
    if (event.type === "session.compacting") {
      return this.#t("progress.steps.compact");
    }
    return this.#t(stepKeyForToolName(event.toolName));
  }

  #appendLineEntry(line: string): void {
    const id = `line:${this.#order.length}`;
    this.#entries.set(id, { kind: "line", line });
    this.#order.push(id);
  }

  #upsertToolEntry(id: string, event: ToolProgressEvent): void {
    if (!this.#entries.has(id)) {
      this.#order.push(id);
    }

    this.#entries.set(id, {
      kind: "tool",
      toolName: event.toolName,
      toolLabel: event.toolLabel,
      status: event.type === "assistant.tool.error" ? "error" : event.type === "assistant.tool.done" ? "done" : "running",
      text: event.text,
    });
  }

  #isToolProgressEvent(event: ProgressEvent): event is ToolProgressEvent {
    return event.type !== "session.compacting";
  }

  #toolEntryId(event: ToolProgressEvent): string | null {
    return event.toolCallId ? `tool:${event.toolCallId}` : null;
  }

  #formatToolEntry(entry: Extract<ProgressEntry, { kind: "tool" }>): string {
    const subject = this.#formatToolSubject(entry.toolName, entry.toolLabel);
    switch (entry.status) {
      case "running":
        return `- ${this.#t("progress.running", { subject })}`;
      case "done":
        return `- ${this.#t("progress.finished", { subject })}`;
      case "error":
        return this.#formatToolErrorLine(subject, entry.text);
    }
  }

  #formatProgressLine(event: ProgressEvent): string {
    switch (event.type) {
      case "session.compacting":
        return `- ${
          event.text
            ? this.#t("progress.compactingWithDetail", { detail: event.text })
            : this.#t("progress.compacting")
        }`;
      case "assistant.tool.running":
      case "assistant.tool.update":
        return `- ${this.#t("progress.running", { subject: this.#formatToolSubject(event.toolName, event.toolLabel) })}`;
      case "assistant.tool.done":
        return `- ${this.#t("progress.finished", { subject: this.#formatToolSubject(event.toolName, event.toolLabel) })}`;
      case "assistant.tool.error":
        return this.#formatToolErrorLine(this.#formatToolSubject(event.toolName, event.toolLabel), event.text);
    }
  }

  #formatToolSubject(toolName: string, toolLabel?: string): string {
    const normalizedLabel = toolLabel?.trim();
    if (!normalizedLabel) {
      return toolName;
    }
    return `${toolName}: ${this.#truncateToolLabel(normalizedLabel)}`;
  }

  #truncateToolLabel(toolLabel: string): string {
    return toolLabel.length > MAX_TOOL_LABEL_DISPLAY_LENGTH
      ? `${toolLabel.slice(0, MAX_TOOL_LABEL_DISPLAY_LENGTH)}…`
      : toolLabel;
  }

  #formatToolErrorLine(toolName: string, text?: string): string {
    const normalizedText = text?.trim();
    if (!normalizedText) {
      return `- ${this.#humanizeToolError(toolName)}`;
    }

    return `- ${this.#t("progress.failedWithDetail", { subject: toolName, detail: normalizedText })}`;
  }

  #humanizeToolError(toolName: string): string {
    return this.#t("progress.failed", { subject: toolName });
  }

  #progressStatus(event: ProgressEvent): string {
    switch (event.type) {
      case "assistant.tool.error":
        return "error";
      case "assistant.tool.done":
        return "done";
      default:
        return "running";
    }
  }
}
