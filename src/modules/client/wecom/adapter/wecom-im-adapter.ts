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
  WecomInboundMessage,
} from "../../../../types";
import { THINKING_LEVELS } from "../../../../types";
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

import {
  ATTACHMENT_MERGE_WINDOW_MS,
  DEFAULT_STEP_HEARTBEAT_INTERVAL_MS,
  FAILURE_NOTICE_COOLDOWN_MS,
  MAX_EGRESS_EVENTS_PER_SESSION,
  MAX_TEXT_CHUNK,
  chunkText,
  clampStreamBody,
  splitFinalBody,
  stripStreamMediaMarkers,
  summarizeToolResult,
  type PendingAttachment,
  type ProgressState,
} from "./wecom-progress-state";

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
  #egressQueues = new Map<string, ClientInputEvent[]>();
  #draining = new Set<string>();
  #lastInboundMessageIdBySession = new Map<string, string>();
  #progressStateBySession = new Map<string, ProgressState>();
  /** Attachment-only messages waiting for the sentence that explains them. */
  #pendingAttachmentsBySession = new Map<string, PendingAttachment>();
  #inboundHandler: ((message: WecomInboundMessage) => Promise<void>) | null = null;
  /** Last time a send-failure notice went out per chat, for the cooldown. */
  #lastFailureNoticeAt = new Map<string, number>();

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
    const now = Date.now();
    const lastNoticeAt = this.#lastFailureNoticeAt.get(chatId) ?? 0;
    if (now - lastNoticeAt < FAILURE_NOTICE_COOLDOWN_MS) {
      this.#logger.debug(`suppressing repeated send-failure notice (chatId=${chatId})`);
      return;
    }
    this.#lastFailureNoticeAt.set(chatId, now);
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
    const handleInbound = async (message: WecomInboundMessage): Promise<void> => {
      const { chatId, chatType, text, messageId, mentionedBot, senderId, quotedText, hasUserText } = message;
      if (!this.#onOutput) {
        this.#logger.warn(`dropping inbound message, adapter not ready (chatId=${chatId})`);
        return;
      }

      this.#logger.info(
        `adapter received inbound message (chatType=${chatType} chatId=${chatId} messageId=${messageId} mentionedBot=${mentionedBot} textLength=${text.trim().length})`,
      );

      const clientSessionId = buildWecomSessionId(chatType, chatId);

      if (
        chatType === "group" &&
        (this.#config.requireMentionInGroup ?? true) &&
        !mentionedBot &&
        !this.#pendingAttachmentsBySession.has(clientSessionId)
      ) {
        this.#logger.debug(
          `ignoring group message without bot mention (session=${clientSessionId} messageId=${messageId})`,
        );
        return;
      }

      const normalizedText = text.trim();
      if (normalizedText.length === 0) {
        // Nothing was extractable: an emoticon, an unsupported msgtype, or an
        // attachment that failed to download. Starting a run on an empty prompt
        // burns a turn and answers a question nobody asked.
        this.#logger.debug(`dropping inbound message without text (session=${clientSessionId})`);
        return;
      }

      if (hasUserText === false) {
        // Attachment without an explanation: hold it briefly so the follow-up
        // sentence can join it, instead of answering a bare file path.
        this.#stashPendingAttachment({
          chatId,
          chatType,
          clientSessionId,
          messageId,
          senderId,
          quotedText,
          text: normalizedText,
        });
        return;
      }

      const helpMarkdown = resolveHelpMarkdown(normalizedText, this.#t);
      if (helpMarkdown) {
        await this.#client?.sendText(chatId, helpMarkdown, messageId);
        return;
      }

      // A malformed `/think` is answered here, before the bubble opens and
      // before anything reaches the core: there is no session to touch and no
      // reason to show a progress bubble for a usage hint.
      const thinkingUsage = this.#resolveThinkingUsage(normalizedText);
      if (thinkingUsage !== null) {
        await this.#client?.sendText(chatId, thinkingUsage, messageId);
        return;
      }

      const parsedCommand = parseSlashCommand(normalizedText, clientSessionId);
      if (parsedCommand && this.#pendingAttachmentsBySession.has(clientSessionId)) {
        // A command is not part of the sentence that explains the attachment.
        await this.#flushPendingAttachment(clientSessionId);
      }
      const pendingAttachment = parsedCommand
        ? undefined
        : this.#takePendingAttachment(clientSessionId);
      const effectiveText = pendingAttachment
        ? `${pendingAttachment.text}\n${normalizedText}`
        : normalizedText;

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
        await this.#announceSteering(chatId, clientSessionId);
      } else {
        this.#lastInboundMessageIdBySession.set(clientSessionId, messageId);
        this.#resetProgressState(clientSessionId);
      }
      const progressState = this.#progressStateBySession.get(clientSessionId);
      if (progressState) {
        progressState.chatType = chatType;
        progressState.senderId = senderId;
      }

      await this.#announceStart(
        chatId,
        this.#lastInboundMessageIdBySession.get(clientSessionId) ?? messageId,
        clientSessionId,
      );

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
        text: this.#composePrompt(effectiveText, chatType, senderId, quotedText),
      });
    };

    this.#inboundHandler = handleInbound;
    this.#client.setOnMessage(handleInbound);

    await this.#client.connect();
    this.#logger.info(
      `adapter started (websocketUrl=${this.#config.websocketUrl ?? "wss://openws.work.weixin.qq.com"})`,
    );
  }

  async stop(): Promise<void> {
    for (const entry of this.#pendingAttachmentsBySession.values()) {
      clearTimeout(entry.timer);
    }
    this.#pendingAttachmentsBySession.clear();
    this.#inboundHandler = null;
    this.#egressQueues.clear();
    this.#draining.clear();
    this.#lastFailureNoticeAt.clear();
    for (const state of this.#progressStateBySession.values()) {
      this.#stopHeartbeat(state);
    }
    this.#progressStateBySession.clear();
    if (this.#client) {
      await this.#client.disconnect();
      this.#client = null;
    }
    this.#onOutput = null;
    this.#logger.info("adapter stopped");
  }

  async input(event: ClientInputEvent): Promise<void> {
    if (!this.#client) {
      throw new Error("WecomIMAdapter is not started");
    }

    const queue = this.#egressQueues.get(event.clientSessionId) ?? [];
    if (queue.length >= MAX_EGRESS_EVENTS_PER_SESSION) {
      // Dropping the oldest is safe: the backlog can only be progress frames,
      // and a newer frame supersedes an older one anyway.
      queue.shift();
      this.#logger.warn(
        `egress queue full, dropping the oldest event (session=${event.clientSessionId})`,
      );
    }
    queue.push(event);
    this.#egressQueues.set(event.clientSessionId, queue);
    void this.#drainSessionQueue(event.clientSessionId);
  }

  async isBusy(): Promise<boolean> {
    if (this.#draining.size > 0) {
      return true;
    }
    for (const queue of this.#egressQueues.values()) {
      if (queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Drains one session's queue. Sessions run independently: a slow attachment
   * upload in one chat no longer holds up a reply in another, which the previous
   * single global lock did.
   */
  async #drainSessionQueue(clientSessionId: string): Promise<void> {
    if (this.#draining.has(clientSessionId)) {
      return;
    }
    this.#draining.add(clientSessionId);
    try {
      while (this.#client) {
        const queue = this.#egressQueues.get(clientSessionId);
        const event = queue?.shift();
        if (!event) {
          break;
        }
        await this.#handleEgressEvent(event);
      }
    } finally {
      this.#draining.delete(clientSessionId);
      const queue = this.#egressQueues.get(clientSessionId);
      if (queue !== undefined && queue.length === 0) {
        this.#egressQueues.delete(clientSessionId);
      }
    }
  }

  async #handleEgressEvent(event: ClientInputEvent): Promise<void> {
    try {
      const target = parseWecomSessionId(event.clientSessionId);

      if (event.type === "assistant.delta") {
        const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
        await this.#handleDeltaEvent(target.chatId, event, replyToMessageId);
        return;
      }

      if (event.type === "agent.run.settled") {
        // Authoritative "the agent will not continue on its own" signal: close
        // the in-place bubble here, never at `assistant.message` (retries,
        // compaction and follow-ups may still produce text).
        const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
        await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId);
        return;
      }

      if (event.type !== "assistant.message") {
        const statusMarkdown = renderStatusMarkdown(event, this.#t);
        if (statusMarkdown) {
          const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
          if (isTerminalAgentError(event) || isCompletedCommandResponse(event)) {
            await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId);
          }
          await this.#client!.sendText(target.chatId, statusMarkdown, replyToMessageId);
          return;
        }

        await this.#handleProgressEvent(target.chatId, event);
        return;
      }

      const replyToMessageId = this.#lastInboundMessageIdBySession.get(event.clientSessionId);
      const state = this.#progressStateBySession.get(event.clientSessionId);
      if (state) {
        state.lastMessageText = event.text;
      }

      // The closing frame of the bubble is the only place the answer is
      // delivered, so the completion event must not repeat it. When this run
      // never reported answer text there is nothing queued for the bubble, so
      // commit the completion text into it right here instead of posting a
      // second message next to a "processing" bubble.
      if (state === undefined || !state.announced) {
        if (event.text.trim().length > 0) {
          const chunks = chunkText(event.text, MAX_TEXT_CHUNK);
          for (const [index, chunk] of chunks.entries()) {
            await this.#client!.sendText(target.chatId, chunk, index === 0 ? replyToMessageId : undefined);
          }
        }
      } else if (state.streaming !== true) {
        await this.#finishProgressMessage(target.chatId, event.clientSessionId, replyToMessageId, event.text);
      }

      for (const attachment of event.attachments ?? []) {
        try {
          await this.#client!.sendAttachment(target.chatId, attachment, replyToMessageId);
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

  /**
   * Tells the user their follow-up was folded into the run already in flight.
   * The note rides the existing bubble instead of posting a second chat message,
   * and the next real step replaces it.
   */
  async #announceSteering(chatId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || !this.#client) {
      return;
    }

    state.stepResult = pickStepVariant(this.#t("progress.steps.steered"), this.#config.stepRandom);
    const body = this.#buildStreamBody(state);
    if (body === state.lastBody) {
      return;
    }
    state.lastBody = body;

    await this.#client.sendStreamText(chatId, body, {
      replyToMessageId: this.#lastInboundMessageIdBySession.get(clientSessionId),
      finish: false,
      nonBlocking: true,
    });
  }

  async #announceStart(chatId: string, messageId: string, clientSessionId: string): Promise<void> {
    const state = this.#progressStateBySession.get(clientSessionId);
    if (!state || state.announced || !this.#client) {
      return;
    }

    const opening = pickStepVariant(this.#t("progress.steps.pool"), this.#config.stepRandom);
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
    this.#applyStepResult(state, event);

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
    const mention = finalText.length > 0 ? this.#senderMention(state) : "";
    const body =
      finalText.length > 0
        ? `${mention}${finalText}`
        : pickStepVariant(this.#t("progress.steps.done"), this.#config.stepRandom);
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
      // The stream is gone — typically the server's 10 minute cap. Reopen a
      // bubble for this message so the answer still lands where the user is
      // looking, instead of leaving a frozen status line behind.
      this.#logger.warn("failed to finish progress message, reopening the bubble:", error);
      if (finalText.length === 0) {
        return;
      }
      this.#client.resetStreamContext(chatId, replyToMessageId);
      try {
        await this.#client.sendStreamText(chatId, head, { replyToMessageId, finish: true });
        if (rest.length > 0) {
          for (const chunk of chunkText(rest, MAX_TEXT_CHUNK)) {
            await this.#client.sendText(chatId, chunk);
          }
        }
        return;
      } catch (retryError) {
        this.#logger.warn("failed to reopen the reply bubble, sending the answer as a message:", retryError);
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
   * Mirrors the latest completed step into the bubble until the next step
   * starts. Running events clear it; update events leave it alone.
   */
  #applyStepResult(
    state: ProgressState,
    event: Exclude<ClientInputEvent, { type: "assistant.message" }>,
  ): void {
    if (event.type === "assistant.tool.running") {
      state.stepResult = undefined;
      return;
    }
    if (event.type !== "assistant.tool.done" && event.type !== "assistant.tool.error") {
      return;
    }
    state.stepResult = this.#stepResultFor(event);
  }

  /**
   * The one extra line shown under a finished step.
   *
   * By default it is a status note, never the tool's output: stdout belongs in a
   * terminal, and pasting it into a chat bubble turns the reply into a log.
   * `stepResultDetail: "raw"` opts back into a truncated excerpt.
   */
  #stepResultFor(
    event: Extract<ClientInputEvent, { type: "assistant.tool.done" | "assistant.tool.error" }>,
  ): string | undefined {
    if (!this.#showStepResult) {
      return undefined;
    }
    if (event.type === "assistant.tool.error") {
      // The step line already reports the failure; a second failure note is noise.
      return undefined;
    }
    if (this.#stepResultDetail === "raw") {
      const raw = summarizeToolResult(event.result);
      return raw ? `${this.#t("progress.steps.resultPrefix")}${raw}` : undefined;
    }
    return pickStepVariant(this.#t("progress.steps.stepDone"), this.#config.stepRandom);
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
    if (!this.#streamAnswer && state.stepResult) {
      sections.push(state.stepResult);
    }
    if (this.#streamAnswer && answer.length > 0) {
      sections.push(answer);
    }

    if (sections.length === 0) {
      return state.announceText ?? pickStepVariant(this.#t("progress.steps.pool"), this.#config.stepRandom);
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
      renderer: new ProgressRenderer({ t: this.#t, mode: this.#progressMode, random: this.#config.stepRandom }),
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

  /** Whether a completed step's result is shown under its line. */
  get #showStepResult(): boolean {
    return this.#config.showStepResult !== false;
  }

  /** Whether a finished step shows a status note or a truncated result excerpt. */
  get #stepResultDetail(): "status" | "raw" {
    return this.#config.stepResultDetail === "raw" ? "raw" : "status";
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
      ? (state.announceText ?? pickStepVariant(this.#t("progress.steps.pool"), this.#config.stepRandom))
      : progress.markdown;
    const base = state.stepResult ? `${subject}\n\n${state.stepResult}` : subject;
    const dots = (state.heartbeatTick % 3) + 1;
    state.heartbeatTick += 1;
    const body = clampStreamBody(`${base}${".".repeat(dots)}`);
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

  /**
   * Builds the prompt the agent sees: who is speaking, what they are replying to,
   * then the message itself.
   *
   * WeCom never sends a display name, so the sender id is used as-is unless
   * `userLabels` maps it to something readable. Direct messages skip the speaker
   * line because there is only one possible speaker. Quoted text is flattened to
   * one line so it cannot swallow the prompt.
   */
  #composePrompt(
    text: string,
    chatType: "dm" | "group",
    senderId?: string,
    quotedText?: string,
  ): string {
    const lines: string[] = [];

    if (chatType === "group" && senderId) {
      const label = this.#config.userLabels?.[senderId]?.trim() || senderId;
      lines.push(`[${this.#t("client.speakerPrefix")}: ${label}]`);
    }

    const quoted = quotedText?.trim().replace(/\s*\n\s*/g, " / ");
    if (quoted) {
      lines.push(`[${this.#t("client.quotePrefix")}: ${quoted}]`);
    }

    lines.push(text);
    return lines.join("\n");
  }

  /**
   * Points a group reply back at whoever asked. Defaults to WeCom's markdown
   * mention syntax; `text` falls back to a literal @label, `none` disables it.
   */
  #senderMention(state: ProgressState): string {
    const mode = this.#config.mentionSender ?? "none";
    if (mode === "none" || !state.senderId || state.chatType !== "group") {
      return "";
    }
    if (mode === "text") {
      const label = this.#config.userLabels?.[state.senderId]?.trim() || state.senderId;
      return `@${label} `;
    }
    return `<@${state.senderId}> `;
  }

  /**
   * Answers a malformed `/think` locally: no level, or a level pi would reject.
   * Returns null when the command is well formed and should go to the core.
   */
  #resolveThinkingUsage(text: string): string | null {
    const match = text.match(/^\/think(?:\s+(.*))?$/i);
    if (!match) {
      return null;
    }
    const level = (match[1] ?? "").trim().toLowerCase();
    if (level.length === 0 || !(THINKING_LEVELS as readonly string[]).includes(level)) {
      return this.#t("client.thinkingUsage");
    }
    return null;
  }

  /**
   * Holds an attachment-only message for a short window so the sentence that
   * explains it can be merged in. Repeated attachments within the window stack.
   */
  #stashPendingAttachment(args: {
    chatId: string;
    chatType: "dm" | "group";
    clientSessionId: string;
    messageId: string;
    senderId?: string;
    quotedText?: string;
    text: string;
  }): void {
    const existing = this.#pendingAttachmentsBySession.get(args.clientSessionId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      void this.#flushPendingAttachment(args.clientSessionId);
    }, ATTACHMENT_MERGE_WINDOW_MS);
    timer.unref?.();

    this.#pendingAttachmentsBySession.set(args.clientSessionId, {
      text: existing ? `${existing.text}\n${args.text}` : args.text,
      messageId: existing?.messageId ?? args.messageId,
      chatId: args.chatId,
      chatType: args.chatType,
      senderId: args.senderId ?? existing?.senderId,
      quotedText: existing?.quotedText ?? args.quotedText,
      timer,
    });
  }

  #takePendingAttachment(clientSessionId: string): PendingAttachment | undefined {
    const entry = this.#pendingAttachmentsBySession.get(clientSessionId);
    if (!entry) {
      return undefined;
    }
    clearTimeout(entry.timer);
    this.#pendingAttachmentsBySession.delete(clientSessionId);
    return entry;
  }

  /**
   * Delivers a stashed attachment on its own: the merge window expired, or a
   * command arrived and must not absorb the path. Re-entering the inbound
   * handler keeps one code path for bubbles, steering and progress state.
   */
  async #flushPendingAttachment(clientSessionId: string): Promise<void> {
    const entry = this.#takePendingAttachment(clientSessionId);
    if (!entry || !this.#inboundHandler) {
      return;
    }
    try {
      await this.#inboundHandler({
        chatId: entry.chatId,
        chatType: entry.chatType,
        messageId: entry.messageId,
        text: entry.text,
        mentionedBot: true,
        senderId: entry.senderId,
        quotedText: entry.quotedText,
        hasUserText: true,
      });
    } catch (error) {
      this.#logger.error("failed to deliver a stashed attachment:", error);
    }
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
