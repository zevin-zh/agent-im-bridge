import type { ProgressRenderer, ProgressRendererMode } from "../../utils/progress-renderer";

/**
 * Bubble state and formatting helpers for the WeCom adapter, kept out of the
 * class so it only deals with orchestration.
 */

export const MAX_TEXT_CHUNK = 4000;
/** One send-failure notice per chat in this window; a flapping socket must not spam the chat. */
export const FAILURE_NOTICE_COOLDOWN_MS = 30000;
/** Per-session backlog ceiling; progress frames are the only thing that can pile up. */
export const MAX_EGRESS_EVENTS_PER_SESSION = 200;
/**
 * A file and the sentence explaining it arrive as two separate WeCom messages.
 * Hold an attachment-only message this long so the follow-up text can join it
 * into one prompt instead of burning a turn on a bare path.
 */
export const ATTACHMENT_MERGE_WINDOW_MS = 3000;
/**
 * WeCom caps a single streamed reply at 20480 bytes and `stream.content` is
 * overwrite-by-design (every frame carries the whole body), so the in-place
 * bubble body must stay under that ceiling. Budgeted in bytes because a CJK
 * character costs three of them.
 */
export const MAX_STREAM_BODY_BYTES = 16000;
/** Lines kept from a completed step's result before the tail is replaced by an ellipsis. */
export const MAX_STEP_RESULT_LINES = 3;
/** Characters kept from those lines, so a single huge line cannot fill the bubble. */
export const MAX_STEP_RESULT_CHARS = 240;
/**
 * How often a motionless bubble is refreshed while a long step is still in
 * flight. Without it the answer-only design would leave the bubble frozen from
 * the moment the last step started until the run settles.
 */
/**
 * How often a motionless bubble is refreshed while a long step is still in
 * flight. Every stream frame rewrites the whole body and the client repaints on
 * each one, so this stays deliberately slow: it only has to prove the run is
 * alive, not to animate the bubble.
 */
export const DEFAULT_STEP_HEARTBEAT_INTERVAL_MS = 15000;

// Display-only twin of the marker pattern in `media-convention.ts`: the delta
// stream may cut a `MEDIA:` marker in half, and files may not exist yet, so
// this strips markers for the bubble without trying to resolve them.
export const STREAM_MEDIA_MARKER_RE =
  /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|(?:~\/|\/|[A-Za-z]:[/\\])[^\s`"']+\.\w+)[`"']?/gi;
export const STREAM_MEDIA_PARTIAL_TAIL_RE = /[`"']?MEDIA:[\s\S]*$/i;

export type PendingAttachment = {
  text: string;
  messageId: string;
  chatId: string;
  chatType: "dm" | "group";
  senderId?: string;
  quotedText?: string;
  timer: ReturnType<typeof setTimeout>;
};

export type ProgressState = {
  renderer: ProgressRenderer;
  announced: boolean;
  /**
   * True once this run reported answer text. The completion event must then not
   * repeat it: the closing frame of the bubble already carries the answer.
   */
  streaming: boolean;
  /** Cumulative answer text for the run, as last reported by `assistant.delta`. */
  answerText: string;
  /**
   * Text of the most recent `assistant.message`: the run's final answer, which
   * is what the closing bubble frame shows when it is available.
   */
  lastMessageText: string;
  /** Chat the bubble belongs to; the heartbeat needs it. */
  chatId?: string;
  replyToMessageId?: string;
  heartbeat?: ReturnType<typeof setInterval>;
  /** Rotates the trailing dots so consecutive heartbeat frames differ. */
  heartbeatTick: number;
  /** Suppresses a heartbeat frame that would repeat the body already sent. */
  lastBody?: string;
  /** The opening line picked for this run; the heartbeat keeps it stable. */
  announceText?: string;
  /**
   * Summary of the step that just finished, shown under the step line until the
   * next step starts. Cleared when a new tool call begins.
   */
  stepResult?: string;
  /** Chat type of the inbound message that opened this bubble. */
  chatType?: "dm" | "group";
  /** Sender of the latest inbound message, used to @ them in a group reply. */
  senderId?: string;
};

/** Strips `MEDIA:` directives (including a half-received trailing one) for display. */
export function stripStreamMediaMarkers(text: string): string {
  return text.replace(STREAM_MEDIA_MARKER_RE, "").replace(STREAM_MEDIA_PARTIAL_TAIL_RE, "").trim();
}

/** Keeps a streamed body under the byte ceiling, preserving both ends of long answers. */
export function clampStreamBody(body: string): string {
  if (Buffer.byteLength(body, "utf8") <= MAX_STREAM_BODY_BYTES) {
    return body;
  }

  const chars = [...body];
  const separator = "\n\n…\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const headBudget = Math.floor(MAX_STREAM_BODY_BYTES * 0.35);

  let head = "";
  let headBytes = 0;
  for (const char of chars) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (headBytes + bytes > headBudget) break;
    head += char;
    headBytes += bytes;
  }

  let tail = "";
  let tailBytes = 0;
  const tailBudget = MAX_STREAM_BODY_BYTES - headBytes - separatorBytes;
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    const bytes = Buffer.byteLength(char, "utf8");
    if (tailBytes + bytes > tailBudget) break;
    tail = char + tail;
    tailBytes += bytes;
  }

  return `${head}${separator}${tail}`;
}

/**
 * Splits the final bubble body into what fits the stream frame and the rest,
 * which is delivered as follow-up messages. Cuts on a line boundary so the
 * markdown that stays in the bubble is not left half-finished.
 */
export function splitFinalBody(body: string): { head: string; rest: string } {
  if (Buffer.byteLength(body, "utf8") <= MAX_STREAM_BODY_BYTES) {
    return { head: body, rest: "" };
  }

  const lines = body.split("\n");
  let head = "";
  let index = 0;
  for (; index < lines.length; index++) {
    const candidate = head.length === 0 ? lines[index] : `${head}\n${lines[index]}`;
    if (Buffer.byteLength(candidate, "utf8") > MAX_STREAM_BODY_BYTES) break;
    head = candidate;
  }

  if (head.length === 0) {
    // One unbroken line larger than the whole budget: fall back to a char cut.
    const chars = [...body];
    let cut = 0;
    let bytes = 0;
    for (const char of chars) {
      const size = Buffer.byteLength(char, "utf8");
      if (bytes + size > MAX_STREAM_BODY_BYTES) break;
      bytes += size;
      cut += 1;
    }
    head = chars.slice(0, cut).join("");
  }

  return { head, rest: body.slice(head.length).replace(/^\n+/, "") };
}

/**
 * Turns a tool result into the few lines worth showing under the step line.
 *
 * Tool results can be megabytes of stdout or deeply nested objects, so this
 * keeps the head, drops the tail and never throws: anything it cannot read
 * simply yields nothing to display.
 */
export function summarizeToolResult(result: unknown): string | undefined {
  const text = readResultText(result, 0);
  if (!text) {
    return undefined;
  }
  const lines = stripStreamMediaMarkers(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  const head = lines.slice(0, MAX_STEP_RESULT_LINES).join("\n");
  const clamped =
    head.length > MAX_STEP_RESULT_CHARS ? `${head.slice(0, MAX_STEP_RESULT_CHARS)}…` : head;
  return lines.length > MAX_STEP_RESULT_LINES ? `${clamped}\n…` : clamped;
}

export function readResultText(value: unknown, depth: number): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? value : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => readResultText(entry, depth + 1))
      .filter((entry): entry is string => entry !== undefined);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["content", "text", "output", "stdout", "result", "message"]) {
      const nested = readResultText(record[key], depth + 1);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitPos = remaining.lastIndexOf("\n", maxLen);
    if (splitPos <= 0) {
      splitPos = remaining.lastIndexOf(" ", maxLen);
    }

    if (splitPos <= 0) {
      chunks.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen);
      continue;
    }

    chunks.push(remaining.slice(0, splitPos + 1));
    remaining = remaining.slice(splitPos + 1);
  }

  return chunks.filter((chunk) => chunk.length > 0);
}
