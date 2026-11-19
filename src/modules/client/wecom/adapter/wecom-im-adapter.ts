import type {
  ChannelCommonContext,
  ClientInputEvent,
  ClientOutputEvent,
  ClientSessionStateStore,
  IMAdapter,
  OnQueueHere,
  OnScheduleHere,
  OnScheduleRun,
  WecomClientConfig,
} from "../../../../types";
import { formatSendFailureNotice, getTranslatorForCommon, type Translator } from "../../../../i18n";
import { createLogger, type Logger } from "../../../../core/logger";
import { isCompletedCommandResponse, isTerminalAgentError } from "../../utils/error-events";
import { pickStepVariant, ProgressRenderer, type ProgressRendererMode } from "../../utils/progress-renderer";
import {
  formatQueueHereReply,
  formatScheduleHereReply,
  formatScheduleRunReply,
  parseSlashCommand,
  resolveHelpMarkdown,
  resolveSlashCommandEvent,
  type QueueHereCommand,
  type QueueHereUsageCommand,
  type ScheduleHereCommand,
  type ScheduleHereUsageCommand,
  type ScheduleRunCommand,
  type ScheduleRunUsageCommand,
  type SessionResumeUsageCommand,
} from "../../utils/slash-commands";
import {
  createInMemoryImClientSessionStateStore,
  type ImClientSessionStateV1,
} from "../../utils/client-session-state";
import { renderStatusMarkdown } from "../../utils/status-markdown";
import { WecomClient } from "./wecom-client";
import { buildWecomSessionId, parseWecomSessionId } from "./wecom-session";

const MAX_TEXT_CHUNK = 4000;
/**
 * WeCom caps a single streamed reply at 20480 bytes and `stream.content` is
 * overwrite-by-design (every frame carries the whole body), so the in-place
 * bubble body must stay under that ceiling. Budgeted in bytes because a CJK
 * character costs three of them.
 */
const MAX_STREAM_BODY_BYTES = 16000;
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
const DEFAULT_STEP_HEARTBEAT_INTERVAL_MS = 15000;

// Display-only twin of the marker pattern in `media-convention.ts`: the delta
// stream may cut a `MEDIA:` marker in half, and files may not exist yet, so
// this strips markers for the bubble without trying to resolve them.
const STREAM_MEDIA_MARKER_RE =
  /[`"']?MEDIA:\s*(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|(?:~\/|\/|[A-Za-z]:[/\\])[^\s`"']+\.\w+)[`"']?/gi;
const STREAM_MEDIA_PARTIAL_TAIL_RE = /[`"']?MEDIA:[\s\S]*$/i;

type ProgressState = {
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
};

/** Strips `MEDIA:` directives (including a half-received trailing one) for display. */
function stripStreamMediaMarkers(text: string): string {
  return text.replace(STREAM_MEDIA_MARKER_RE, "").replace(STREAM_MEDIA_PARTIAL_TAIL_RE, "").trim();
}

/** Keeps a streamed body under the byte ceiling, preserving both ends of long answers. */
function clampStreamBody(body: string): string {
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
function splitFinalBody(body: string): { head: string; rest: string } {
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

function chunkText(text: string, maxLen: number): string[] {
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

export class WecomIMAdapter implements IMAdapter {
  /**
   * WeCom bots support an in-place streamed reply (one bubble per inbound
   * message), so the core may forward `assistant.delta` / `agent.run.settled`
   * to this adapter.
   */
  readonly supportsStreaming = true;

  readonly #config: WecomClientConfig;
  readonly #logger: Logger;
  readonly #t: Translator;
  readonly #sessionState: ClientSessionStateStore<ImClientSessionStateV1>;
  readonly #onScheduleRun: OnScheduleRun | undefined;
  readonly #onScheduleHere: OnScheduleHere | undefined;
  readonly #onQueueHere: OnQueueHere | undefined;
  #onOutput: ((event: ClientOutputEvent) => Promise<void> | void) | null = null;
  #client: WecomClient | null = null;
  #egressQueue: ClientInputEvent[] = [];
  #processing = false;
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<string, ProgressState>();

  async #notifySendFailure(chatId: string, error: unknown): Promise<void> {
    if (!this.#client) {
      return;
    }
    if (this.#client.isKicked()) {
      // The connection is gone for good; a failure notification cannot be
      // delivered either, so don't attempt one.
      this.#logger.debug("skipping send-failure notification, connection was replaced");
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const text = formatSendFailureNotice(this.#t, message);

    try {
      await this.#client.sendText(chatId, text);
    } catch (notifyError) {
      this.#logger.error("failed to notify send failure:", notifyError);
    }
  }

  constructor(
    config: WecomClientConfig,
    logger: Logger = createLogger("wecom"),
    common?: ChannelCommonContext,
    sessionState: ClientSessionStateStore<ImClientSessionStateV1> = createInMemoryImClientSessionStateStore(
      "wecom",
    ),
    onScheduleRun?: OnScheduleRun,
    onScheduleHere?: OnScheduleHere,
    onQueueHere?: OnQueueHere,
  ) {
    this.#config = config;
    this.#logger = logger;
    this.#t = getTranslatorForCommon(common);
    this.#sessionState = sessionState;
    this.#onScheduleRun = onScheduleRun;
    this.#onScheduleHere = onScheduleHere;
    this.#onQueueHere = onQueueHere;
  }

  async start(onOutput: (event: ClientOutputEvent) => Promise<void> | void): Promise<void> {
    this.#onOutput = onOutput;
    this.#client = new WecomClient(this.#config, this.#logger);
    this.#client.setOnKicked(() => {
      this.#logger.error(
        "this bot connection was replaced by a newer connection (another instance is running with the same bot credentials); " +
          "this instance will keep running but can no longer receive or send messages — stop the other instance and restart this process to recover",
      );
    });
    this.#client.setOnMessage(async ({ chatId, chatType, text, messageId, mentionedBot }) => {
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      this.#logger.info(
        `adapter received inbound message (chatType=${chatType} chatId=${chatId} messageId=${messageId} mentionedBot=${mentionedBot} textLength=${text.trim().length})`,
      );

      const clientSessionId = buildWecomSessionId(chatType, chatId);

      if (chatType === "group" && (this.#config.requireMentionInGroup ?? true) && !mentionedBot) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      const normalizedText = text.trim();
      const helpMarkdown = resolveHelpMarkdown(normalizedText, this.#t);
      if (helpMarkdown) {
        await this.#client?.sendText(chatId, helpMarkdown, messageId);
        return;
      }

      // One run, one bubble. A second message while the agent is still working
      // steers that run (`prompt(..., "steer")` in the pi adapter), so it must
      // not open a new bubble: a fresh messageId allocates a new streamId and
      // leaves the first bubble frozen mid-sentence. Only a settled run starts
      // over with a new one.
      const activeState = this.#progressStateBySession.get(clientSessionId);
      const steeringActiveRun = activeState !== undefined && activeState.announced;
      if (steeringActiveRun) {
        this.#logger.info(
          `steering the active run, keeping its bubble (session=${clientSessionId} messageId=${messageId})`,
        );
      } else {
        this.#lastInboundMessageIdBySession.set(clientSessionId, messageId);
        this.#resetProgressState(clientSessionId);
      }
      await this.#announceStart(
        chatId,
        this.#lastInboundMessageIdBySession.get(clientSessionId) ?? messageId,
        clientSessionId,
      );

      const parsedCommand = parseSlashCommand(normalizedText, clientSessionId);
      if (parsedCommand) {
        if (parsedCommand.type === "schedule.run" || parsedCommand.type === "schedule.run.usage") {
          // Adapter-local manual trigger (spec D7a): never reaches the core.
          this.#logger.info(`received local schedule-run command ${normalizedText} (session=${clientSessionId})`);
          await this.#handleScheduleRun(parsedCommand, chatId, messageId);
          return;
        }
        if (parsedCommand.type === "schedule.here" || parsedCommand.type === "schedule.here.usage") {
          // Adapter-local target binding (spec D7): never reaches the core.
          this.#logger.info(`received local schedule-here command ${normalizedText} (session=${clientSessionId})`);
          await this.#handleScheduleHere(parsedCommand, chatId, messageId);
          return;
        }
        if (parsedCommand.type === "queue.here" || parsedCommand.type === "queue.here.usage") {
          // Adapter-local queue target binding (spec D4): never reaches the core.
          this.#logger.info(`received local queue-here command ${normalizedText} (session=${clientSessionId})`);
          await this.#handleQueueHere(parsedCommand, chatId, messageId);
          return;
        }
        if (parsedCommand.type === "command.session.resume.usage") {
          // Adapter-local usage error (spec /resume): never reaches the core.
          // Intercepting here also narrows the union for TS before
          // `resolveSlashCommandEvent`, which only accepts `ClientOutputEvent`
          // shapes (see plan §3.4).
          this.#logger.info(`received local resume command ${normalizedText} (session=${clientSessionId})`);
          await this.#client?.sendText(chatId, this.#t("client.resumeUsage"), messageId);
          return;
        }
        const resolved = await resolveSlashCommandEvent(parsedCommand, {
          sessionState: this.#sessionState.session(clientSessionId),
          onError: (error) =>
            this.#logger.error("failed to resolve the remembered /new working directory:", error),
        });
        // The adapter may have stopped while the store resolution was in
        // flight; never emit through a torn-down output handler.
        if (!this.#onOutput) return;
        if (resolved.type === "invalid-working-directory") {
          const text = resolved.remembered
            ? this.#t("client.invalidRememberedWorkingDirectory", {
                workingDirectory: resolved.workingDirectory,
                detail: resolved.detail,
              })
            : this.#t("client.invalidNewWorkingDirectory", {
                workingDirectory: resolved.workingDirectory,
                detail: resolved.detail,
              });
          await this.#client?.sendText(chatId, text, messageId);
          return;
        }
        await this.#onOutput(resolved);
        return;
      }

      await this.#onOutput({
        type: "user.message",
        clientSessionId,
        text,
      });
    });

    await this.#client.connect();
    this.#logger.info(
      `adapter started (websocketUrl=${this.#config.websocketUrl ?? "wss://openws.work.weixin.qq.com"})`,
    );
  }

  async stop(): Promise<void> {
    this.#egressQueue.length = 0;
    for (const state of this.#progressStateBySession.values()) {
      this.#stopHeartbeat(state);
    }
    this.#progressStateBySession.clear();
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#processing = false;
    this.#onOutput = null;
    this.#logger.info("adapter stopped");
  }

  async input(event: ClientInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("WecomIMAdapter is not started");
    }

    this.#egressQueue.push(event);
    void this.#drainEgressQueue();
  }

  async isBusy(): Promise<boolean> {
    return this.#processing || this.#egressQueue.length > 0;
  }

  async #drainEgressQueue(): Promise<void> {
    if (this.#processing) {
      return;
    }

    this.#processing = true;
    try {
      while (this.#client && this.#egressQueue.length > 0) {
        const event = this.#egressQueue.shift();
        if (!event) continue;

        try {
          const target = parseWecomSessionId(event.clientSessionId);

          if (event.type === "assistant.delta") {
            const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
            await this.#handleDeltaEvent(target.chatId, event, replyToMessageId);
            continue;
          }

          if (event.type === "agent.run.settled") {
            // Authoritative "the agent will not continue on its own" signal:
            // close the in-place bubble here, never at `assistant.message`
            // (retries, compaction and follow-ups may still produce text).
            const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
            await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId);
            continue;
          }

          if (event.type !== "assistant.message") {
            const statusMarkdown = renderStatusMarkdown(event, this.#t);
            if (statusMarkdown) {
              const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
              if (isTerminalAgentError(event) || isCompletedCommandResponse(event)) {
                await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId);
              }
              await this.#client.sendText(target.chatId, statusMarkdown, replyToMessageId);
              continue;
            }

            await this.#handleProgressEvent(target.chatId, event);
            continue;
          }

          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          const state = this.#progressStateBySession.get(event.clientSessionId);
          if (state) {
            state.lastMessageText = event.text;
          }

          // The closing frame of the bubble is the only place the answer is
          // delivered, so the completion event must not repeat it. When this
          // run never reported answer text there is nothing queued for the
          // bubble, so commit the completion text into it right here instead of
          // posting a second message next to a "processing" bubble.
          if (state === undefined || !state.announced) {
            if (event.text.trim().length > 0) {
              const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
              for (const [index, chunk] of chunks.entries()) {
                await this.#client.sendText(target.chatId, chunk, index === 0 ? replyToMessageId : undefined);
              }
            }
          } else if (state.streaming !== true) {
            await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId, event.text);
          }
          for (const attachment of event.attachments ?? []) {
            try {
              await this.#client.sendAttachment(target.chatId, attachment, replyToMessageId);
            } catch (attachmentError) {
              this.#logger.error("failed to send attachment:", attachmentError);
              await this.#notifySendFailure(target.chatId, attachmentError);
            }
          }
        } catch (error) {
          this.#logger.error("failed to send egress event:", error);
          try {
            const target = parseWecomSessionId(event.clientSessionId);
            await this.#notifySendFailure(target.chatId, error);
          } catch (notifyError) {
            this.#logger.error("failed to handle egress send failure:", notifyError);
          }
        }
      }
    } finally {
      this.#processing = false;
    }
  }

  async #announceStart(chatId: string, messageId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || state.announced || !this.#client) {
      return;
    }

    const opening = pickStepVariant(this.#t("progress.steps.pool"));
    await this.#client.sendStreamText(chatId, opening, {
      replyToMessageId: messageId,
      finish: false,
    });
    state.announced = true;
    state.lastBody = opening;
    state.announceText = opening;
    this.#startHeartbeat(state, chatId, messageId);
  }

  async #handleProgressEvent(
    chatId: string,
    event: Exclude<ClientInputEvent, { type: "assistant.message" }>,
  ): Promise<void> {
    if (!this.#client) {
      return;
    }

    const state = this.#getOrCreateProgressState(event.clientSessionId);
    if (!state.renderer.isProgressEvent(event)) {
      return;
    }
    state.renderer.takeProgressEvent(event);

    // Refresh the same stream message in place, like the feishu adapter
    // updates its progress card. Go through #buildStreamBody so that answer
    // text already collected for the closing frame cannot be overwritten by a
    // late tool event.
    const body = this.#buildStreamBody(state);
    const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
    state.announced = true;
    this.#startHeartbeat(state, chatId, replyToMessageId);

    // An identical body is a pure repaint. Every tool call emits running,
    // several updates and done, and in steps mode they all carry the same line,
    // so sending them would rewrite the bubble over and over for no visible
    // change. Skip those instead of flickering.
    if (body === state.lastBody) {
      return;
    }
    state.lastBody = body;
    await this.#client.sendStreamText(chatId, body, {
      replyToMessageId,
      finish: false,
      // A superseded step frame is worthless; dropping it beats queueing it
      // behind an unacked frame and letting the bubble lag seconds behind.
      nonBlocking: true,
    });
  }

  /**
   * Closes the in-place bubble with the final answer.
   *
   * WeCom's stream frame carries the whole body every time, so the closing frame
   * *is* the "clear the bubble" step: whatever step lines were shown before are
   * replaced by the result. Bodies over the stream ceiling keep the head in the
   * bubble and deliver the remainder as follow-up messages, so a long answer is
   * never silently truncated.
   */
  async #finishProgressMessage(
    chatId: string,
    clientSessionId: string,
    replyToMessageId?: string,
    overrideText?: string,
  ): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state) {
      return;
    }
    this.#progressStateBySession.delete(clientSessionId);
    this.#stopHeartbeat(state);
    if (!state.announced || !this.#client) {
      return;
    }

    const finalText = this.#resolveFinalText(state, overrideText);
    const body =
      finalText.length > 0 ? finalText : pickStepVariant(this.#t("progress.steps.done"));
    const { head, rest } = splitFinalBody(body);
    try {
      await this.#client.sendStreamText(chatId, head, { replyToMessageId, finish: true });
      if (rest.length > 0) {
        this.#logger.info(
          `final answer exceeded the stream body limit, delivering ${Buffer.byteLength(rest, "utf8")} more bytes as follow-up messages (session=${clientSessionId})`,
        );
        for (const chunk of chunkText(rest, MAX_TEXT_CHUNK)) {
          await this.#client.sendText(chatId, chunk);
        }
      }
    } catch (error) {
      // The stream may already have been auto-closed by the server (10 minute
      // limit); the final answer is sent as a separate message regardless.
      this.#logger.warn("failed to finish progress message:", error);
      if (finalText.length === 0) {
        return;
      }
      for (const chunk of chunkText(finalText, MAX_TEXT_CHUNK)) {
        try {
          await this.#client.sendText(chatId, chunk);
        } catch (sendError) {
          this.#logger.error("failed to send the final answer after a stream failure:", sendError);
          break;
        }
      }
    }
  }

  /**
   * Renders the in-progress bubble body.
   *
   * The default `steps` mode keeps it to a single status line describing what
   * the agent is doing right now. Tool names, arguments and results stay out:
   * the bubble is not a build log. Answer text is withheld until the closing
   * frame so the result lands in one piece. `streamAnswer: true` restores the
   * older behavior of typing the answer into the bubble as it arrives.
   */
  #buildStreamBody(state: ProgressState): string {
    const progress = state.renderer.getCurrentProgress();
    const answer = stripStreamMediaMarkers(state.answerText);

    const sections: string[] = [];
    if (!progress.isEmpty && (answer.length === 0 || !this.#streamAnswer)) {
      sections.push(progress.markdown);
    }
    if (this.#streamAnswer && answer.length > 0) {
      sections.push(answer);
    }

    if (sections.length === 0) {
      return state.announceText ?? pickStepVariant(this.#t("progress.steps.pool"));
    }
    return clampStreamBody(sections.join("\n\n"));
  }

  /** The text the closing frame shows: the run's last answer, else everything it wrote. */
  #resolveFinalText(state: ProgressState, overrideText?: string): string {
    const explicit = overrideText?.trim();
    if (explicit) {
      return stripStreamMediaMarkers(explicit);
    }
    const lastMessage = stripStreamMediaMarkers(state.lastMessageText);
    if (lastMessage.length > 0) {
      return lastMessage;
    }
    return stripStreamMediaMarkers(state.answerText);
  }

  #getOrCreateProgressState(clientSessionId: string): ProgressState {
    const existing = this.#progressStateBySession.get(clientSessionId);
    if (existing) {
      return existing;
    }
    const created = this.#createProgressState();
    this.#progressStateBySession.set(clientSessionId, created);
    return created;
  }

  #createProgressState(): ProgressState {
    return {
      renderer: new ProgressRenderer({ t: this.#t, mode: this.#progressMode }),
      announced: false,
      streaming: false,
      answerText: "",
      lastMessageText: "",
      heartbeatTick: 0,
    };
  }

  /** Progress rendering style for this channel; `log` keeps the per-tool lines. */
  get #progressMode(): ProgressRendererMode {
    return this.#config.replyProgress === "log" ? "log" : "steps";
  }

  /** Whether answer text is typed into the bubble instead of landing on settle. */
  get #streamAnswer(): boolean {
    return this.#config.streamAnswer === true;
  }

  #startHeartbeat(state: ProgressState, chatId: string, replyToMessageId?: string): void {
    state.chatId = chatId;
    state.replyToMessageId = replyToMessageId;
    if (state.heartbeat) {
      return;
    }
    const intervalMs = this.#stepHeartbeatIntervalMs;
    if (intervalMs <= 0) {
      return;
    }
    state.heartbeat = setInterval(() => {
      void this.#sendHeartbeat(state);
    }, intervalMs);
    state.heartbeat.unref?.();
  }

  /** Configured heartbeat cadence; `0` or a negative value turns it off. */
  get #stepHeartbeatIntervalMs(): number {
    const configured = this.#config.stepHeartbeatMs;
    return typeof configured === "number" && Number.isFinite(configured)
      ? configured
      : DEFAULT_STEP_HEARTBEAT_INTERVAL_MS;
  }

  #stopHeartbeat(state: ProgressState): void {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = undefined;
    }
  }

  /**
   * Keeps a motionless bubble alive during a long step. A rotating dot is the
   * only thing that changes when nothing else does: the bubble stays visibly
   * alive without putting a clock on screen.
   */
  async #sendHeartbeat(state: ProgressState): Promise<void> {
    if (!this.#client || !state.announced || !state.chatId) {
      return;
    }
    if (this.#streamAnswer && state.answerText.length > 0) {
      return;
    }

    const progress = state.renderer.getCurrentProgress();
    const subject = progress.isEmpty
      ? (state.announceText ?? pickStepVariant(this.#t("progress.steps.pool")))
      : progress.markdown;
    const dots = (state.heartbeatTick % 3) + 1;
    state.heartbeatTick += 1;
    const body = `${subject}${".".repeat(dots)}`;
    if (body === state.lastBody) {
      return;
    }
    state.lastBody = body;

    try {
      await this.#client.sendStreamText(state.chatId, body, {
        replyToMessageId: state.replyToMessageId,
        finish: false,
        nonBlocking: true,
      });
    } catch (error) {
      this.#logger.debug("failed to send step heartbeat:", error);
    }
  }

  /**
   * Records the cumulative answer text for the run.
   *
   * By default nothing is rendered here: the bubble keeps showing the step in
   * flight and the answer replaces it wholesale in the closing frame, so the
   * result does not type itself out over the top of the progress line. With
   * `streamAnswer: true` the older in-place typing behavior is restored.
   */
  async #handleDeltaEvent(
    chatId: string,
    event: Extract<ClientInputEvent, { type: "assistant.delta" }>,
    replyToMessageId?: string,
  ): Promise<void> {
    if (!this.#client) {
      return;
    }

    const state = this.#getOrCreateProgressState(event.clientSessionId);
    state.streaming = true;
    state.answerText = event.text;

    if (!this.#streamAnswer) {
      return;
    }

    const body = this.#buildStreamBody(state);
    state.lastBody = body;
    await this.#client.sendStreamText(chatId, body, {
      replyToMessageId,
      finish: false,
      nonBlocking: true,
    });
    state.announced = true;
  }

  #resetProgressState(clientSessionId: string): void {
    const previous = this.#progressStateBySession.get(clientSessionId);
    if (previous) {
      this.#stopHeartbeat(previous);
    }
    this.#progressStateBySession.set(clientSessionId, this.#createProgressState());
  }

  async #handleScheduleRun(
    command: ScheduleRunCommand | ScheduleRunUsageCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (command.type === "schedule.run.usage") {
      await this.#client?.sendText(chatId, this.#t("client.scheduleRunUsage"), messageId);
      return;
    }

    if (!this.#onScheduleRun) {
      // The runner always injects the bridge (spec D7a); degrade gracefully
      // if it is ever absent: log, and reply nothing.
      this.#logger.warn(
        `onScheduleRun is not injected; dropping /schedule-run for task "${command.taskName}" (session=${command.clientSessionId})`,
      );
      return;
    }

    const result = await this.#onScheduleRun(command.taskName, command.clientSessionId);
    await this.#client?.sendText(
      chatId,
      formatScheduleRunReply(result, command.taskName, this.#t),
      messageId,
    );
  }

  async #handleScheduleHere(
    command: ScheduleHereCommand | ScheduleHereUsageCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (command.type === "schedule.here.usage") {
      await this.#client?.sendText(chatId, this.#t("client.scheduleHereUsage"), messageId);
      return;
    }

    if (!this.#onScheduleHere) {
      // The runner always injects the bridge (spec D7); degrade gracefully
      // if it is ever absent: log, and reply nothing.
      this.#logger.warn(
        `onScheduleHere is not injected; dropping /schedule-here for task "${command.taskName}" (session=${command.clientSessionId})`,
      );
      return;
    }

    const result = await this.#onScheduleHere(command.taskName, command.clientSessionId);
    await this.#client?.sendText(
      chatId,
      formatScheduleHereReply(result, command.taskName, this.#t),
      messageId,
    );
  }

  async #handleQueueHere(
    command: QueueHereCommand | QueueHereUsageCommand,
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (command.type === "queue.here.usage") {
      await this.#client?.sendText(chatId, this.#t("client.queueHereUsage"), messageId);
      return;
    }

    if (!this.#onQueueHere) {
      // The runner always injects the bridge (spec D4); degrade gracefully
      // if it is ever absent: log, and reply nothing.
      this.#logger.warn(
        `onQueueHere is not injected; dropping /queue-here for queue "${command.queueName}" (session=${command.clientSessionId})`,
      );
      return;
    }

    const result = await this.#onQueueHere(command.queueName, command.clientSessionId);
    await this.#client?.sendText(
      chatId,
      formatQueueHereReply(result, command.queueName, this.#t),
      messageId,
    );
  }
}
