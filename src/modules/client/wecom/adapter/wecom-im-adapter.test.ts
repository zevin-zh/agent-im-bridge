import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientOutputEvent, WecomInboundMessage } from "../../../../types";
import { createLogger } from "../../../../core/logger";
import { getTranslator } from "../../../../i18n";
import { WecomIMAdapter } from "./wecom-im-adapter";

type FakeClientInstance = {
  setOnMessage: (handler: (message: WecomInboundMessage) => Promise<void> | void) => void;
  setOnKicked: (handler: () => void) => void;
  isKicked: () => boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendText: (chatId: string, text: string, replyToMessageId?: string) => Promise<void>;
  sendStreamText: (
    chatId: string,
    text: string,
    options?: { replyToMessageId?: string; finish?: boolean; feedbackId?: string },
  ) => Promise<void>;
  sendAttachment: (chatId: string, attachment: unknown, replyToMessageId?: string) => Promise<void>;
  resetStreamContext: (chatId: string, messageId?: string) => void;
};

const fakeClientState: {
  onMessage: ((message: WecomInboundMessage) => Promise<void> | void) | null;
  onKicked: (() => void) | null;
  kicked: boolean;
  sendText: ReturnType<typeof vi.fn>;
  sendStreamText: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendAttachment: ReturnType<typeof vi.fn>;
  resetStreamContext: ReturnType<typeof vi.fn>;
} = {
  onMessage: null,
  onKicked: null,
  kicked: false,
  sendText: vi.fn(async () => {}),
  sendStreamText: vi.fn(async () => {}),
  connect: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  sendAttachment: vi.fn(async () => {}),
  resetStreamContext: vi.fn(),
};

vi.mock("./wecom-client", () => {
  return {
    WecomClient: vi.fn().mockImplementation(
      (): FakeClientInstance => ({
        setOnMessage(handler) {
          fakeClientState.onMessage = handler;
        },
        setOnKicked(handler) {
          fakeClientState.onKicked = handler;
        },
        isKicked() {
          return fakeClientState.kicked;
        },
        connect: fakeClientState.connect,
        disconnect: fakeClientState.disconnect,
        sendText: fakeClientState.sendText,
        sendStreamText: fakeClientState.sendStreamText,
        sendAttachment: fakeClientState.sendAttachment,
        resetStreamContext: fakeClientState.resetStreamContext,
      }),
    ),
  };
});

function resetFakeClient(): void {
  fakeClientState.onMessage = null;
  fakeClientState.onKicked = null;
  fakeClientState.kicked = false;
  fakeClientState.sendText.mockReset();
  fakeClientState.sendText.mockImplementation(async () => {});
  fakeClientState.sendStreamText.mockReset();
  fakeClientState.sendStreamText.mockImplementation(async () => {});
  fakeClientState.connect.mockReset();
  fakeClientState.connect.mockImplementation(async () => {});
  fakeClientState.disconnect.mockReset();
  fakeClientState.disconnect.mockImplementation(async () => {});
  fakeClientState.sendAttachment.mockReset();
  fakeClientState.sendAttachment.mockImplementation(async () => {});
  fakeClientState.resetStreamContext.mockReset();
}

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition not met in time");
}

const enTranslator = getTranslator("en-US");
const zhTranslator = getTranslator("zh-CN");

/**
 * Every step line lives in an `a|b|c` pool and the pick is random, so tests
 * assert pool membership instead of a specific line.
 */
function isStepOfPoolIn(
  translator: ReturnType<typeof getTranslator>,
  key: string,
  value: unknown,
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return translator(key)
    .split("|")
    .map((entry) => entry.trim())
    .includes(value);
}

function isStepOfPool(key: string, value: unknown): boolean {
  return isStepOfPoolIn(enTranslator, key, value);
}

/** True when `body` contains one of the variants of an `a|b|c` pool. */
function containsStepVariant(key: string, body: unknown): boolean {
  if (typeof body !== "string") {
    return false;
  }
  return enTranslator(key)
    .split("|")
    .map((entry) => entry.trim())
    .some((entry) => entry.length > 0 && body.includes(entry));
}

describe("WecomIMAdapter", () => {
  afterEach(() => {
    resetFakeClient();
    vi.useRealTimers();
  });

  it("ignores group messages without bot mention", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("accepts direct messages and immediately acknowledges with a short message", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-2",
      text: "hello",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "wecom:dm:user_1",
      text: "hello",
    });
    expect(isStepOfPool("progress.steps.pool", fakeClientState.sendStreamText.mock.calls[0]?.[1])).toBe(
      true,
    );
    expect(fakeClientState.sendStreamText.mock.calls[0]?.[2]).toEqual({
      replyToMessageId: "msg-2",
      finish: false,
    });
  });

  it("localizes the starting message and delivery failure notice in Chinese", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      { channelName: "demo-channel", language: "zh-CN" },
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_zh",
      chatType: "group",
      messageId: "msg-zh-1",
      text: "你好",
      mentionedBot: true,
    });

    expect(
      isStepOfPoolIn(zhTranslator, "progress.steps.pool", fakeClientState.sendStreamText.mock.calls[0]?.[1]),
    ).toBe(true);
    expect(fakeClientState.sendStreamText.mock.calls[0]?.[2]).toEqual({
      replyToMessageId: "msg-zh-1",
      finish: false,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("field validation failed"))
      .mockResolvedValueOnce(undefined);

    // A terminal error replies with its own text message; when that send fails
    // the user gets the localized delivery-failure notice.
    await adapter.input({
      type: "error",
      clientSessionId: "wecom:group:group_zh",
      kind: "agent.run.failed",
      detail: "boom",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("[agent-bridge 错误] 消息发送失败");
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("field validation failed");
  });

  it("handles /h locally without forwarding it to the core", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-help",
      text: "/h",
      mentionedBot: false,
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Available commands:"),
      "msg-help",
    );
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();
  });

  it("forwards /st to the core as a command event", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-status",
      text: "/st",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.status",
      clientSessionId: "wecom:dm:user_1",
    });
    expect(isStepOfPool("progress.steps.pool", fakeClientState.sendStreamText.mock.calls[0]?.[1])).toBe(
      true,
    );
    expect(fakeClientState.sendStreamText.mock.calls[0]?.[2]).toEqual({
      replyToMessageId: "msg-status",
      finish: false,
    });

    await adapter.input({
      type: "agent.status.info",
      clientSessionId: "wecom:dm:user_1",
      status: { sessionId: "agent-1" },
    });
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendStreamText).toHaveBeenLastCalledWith("user_1", expect.any(String), {
      replyToMessageId: "msg-status",
      finish: true,
    });
    expect(isStepOfPool("progress.steps.done", fakeClientState.sendStreamText.mock.calls.at(-1)?.[1])).toBe(
      true,
    );
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Current session status"),
      "msg-status",
    );
  });

  it("forwards /m anthropic/claude-sonnet-4-5 to the core as a model-set command event", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-model-set",
      text: "/m anthropic/claude-sonnet-4-5",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.model.set",
      clientSessionId: "wecom:dm:user_1",
      target: "anthropic/claude-sonnet-4-5",
    });
  });

  it("forwards /stop to the core as a command event", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-stop",
      text: "/stop",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.stop",
      clientSessionId: "wecom:dm:user_1",
    });
  });

  it("commits the whole answer into the bubble instead of posting a second message", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-3",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.sendStreamText.mockClear();
    fakeClientState.sendText.mockClear();

    const answer = `${"a".repeat(3999)} ${"b".repeat(50)}`;
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:group:group_1",
      text: answer,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );

    expect(fakeClientState.sendStreamText).toHaveBeenCalledTimes(1);
    expect(fakeClientState.sendStreamText).toHaveBeenCalledWith("group_1", answer, {
      replyToMessageId: "msg-3",
      finish: true,
    });
    // The bubble *is* the answer: no follow-up message.
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("keeps a body over the stream ceiling in the bubble and follows up with the remainder", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-overflow",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.sendStreamText.mockClear();
    fakeClientState.sendText.mockClear();

    const head = "a".repeat(16000);
    const tail = "b".repeat(2000);
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:group:group_1",
      text: `${head}\n${tail}`,
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe(head);
    expect(fakeClientState.sendText).toHaveBeenCalledTimes(1);
    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toBe(tail);
    expect(fakeClientState.sendText.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("notifies the user when delivery fails", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-4",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.sendText.mockClear();
    fakeClientState.sendText
      .mockRejectedValueOnce(new Error("field validation failed"))
      .mockResolvedValueOnce(undefined);

    await adapter.input({
      type: "error",
      clientSessionId: "wecom:group:group_1",
      kind: "agent.run.failed",
      detail: "boom",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    expect(fakeClientState.sendText.mock.calls[1]?.[0]).toBe("group_1");
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain(
      "[agent-bridge error] Message delivery failed",
    );
    expect(fakeClientState.sendText.mock.calls[1]?.[1]).toContain("field validation failed");
  });

  it("skips the failure notification when the connection was replaced", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-kicked-1",
      text: "hello",
      mentionedBot: true,
    });

    fakeClientState.kicked = true;
    fakeClientState.sendStreamText.mockClear();
    fakeClientState.sendText.mockClear();
    fakeClientState.sendText.mockRejectedValue(new Error("WebSocket not connected"));

    await adapter.input({
      type: "error",
      clientSessionId: "wecom:group:group_1",
      kind: "agent.run.failed",
      detail: "boom",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);
    // Give the drain loop a chance to (wrongly) attempt the notification.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fakeClientState.sendText).toHaveBeenCalledTimes(1);
  });

  it("finishes progress and renders terminal agent errors", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-run-error",
      text: "do work",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();
    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.run.failed",
      detail: "Provider connection failed",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);
    expect(fakeClientState.sendStreamText).toHaveBeenCalledWith("user_1", expect.any(String), {
      replyToMessageId: "msg-run-error",
      finish: true,
    });
    expect(isStepOfPool("progress.steps.done", fakeClientState.sendStreamText.mock.calls.at(-1)?.[1])).toBe(
      true,
    );
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Provider connection failed"),
      "msg-run-error",
    );
  });

  it("does not finish progress for non-terminal command errors", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-model-error",
      text: "do work",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.model.busy",
    });

    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();
  });

  it("renders structured status and model errors as localized text replies", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      { channelName: "demo-channel", language: "zh-CN" },
    );

    await adapter.start(async () => {});
    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.status.unavailable",
      detail: "RPC timeout",
    });
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("当前无法获取会话状态。"),
      undefined,
    );

    fakeClientState.sendText.mockClear();
    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.model.busy",
    });
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);

    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("当前正在运行，无法切换模型"),
      undefined,
    );
  });

  it("renders one semantic step line instead of the tool log", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-progress-1",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.thinking",
      clientSessionId: "wecom:dm:user_1",
      text: "Planning",
    });
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "web_search",
      text: undefined,
    });
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: undefined,
    });
    await adapter.input({
      type: "assistant.tool.error",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: undefined,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) =>
        isStepOfPool("progress.steps.failed", call[1]),
      ),
    );

    // Every frame starts from a pool line; the last one reports the failure.
    // Frames with an unchanged body are skipped, so the exact count is not fixed.
    for (const call of fakeClientState.sendStreamText.mock.calls) {
      expect(
        containsStepVariant("progress.steps.pool", call[1]) ||
          containsStepVariant("progress.steps.failed", call[1]),
      ).toBe(true);
      expect(call[1]).not.toContain("web_search");
      expect(call[1]).not.toContain("bash");
    }
    expect(
      isStepOfPool("progress.steps.failed", fakeClientState.sendStreamText.mock.calls.at(-1)?.[1]),
    ).toBe(true);
    expect(fakeClientState.sendStreamText.mock.calls.at(-1)?.[2]).toEqual({
      replyToMessageId: "msg-progress-1",
      finish: false,
      nonBlocking: true,
    });
  });

  it("shows a collapsed-updates summary while refreshing the same progress stream", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        replyProgress: "log",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-collapse",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendStreamText.mockClear();

    for (let index = 1; index <= 12; index += 1) {
      await adapter.input({
        type: "assistant.tool.running",
        clientSessionId: "wecom:dm:user_1",
        agentSessionId: "agent-1",
        toolName: `tool_${index}`,
        text: undefined,
      });
    }

    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length === 12);

    expect(fakeClientState.sendStreamText.mock.calls[11]?.[1]).toBe(
      [
        "- Collapsed 2 earlier updates.",
        "- ⏳ tool_3",
        "- ⏳ tool_4",
        "- ⏳ tool_5",
        "- ⏳ tool_6",
        "- ⏳ tool_7",
        "- ⏳ tool_8",
        "- ⏳ tool_9",
        "- ⏳ tool_10",
        "- ⏳ tool_11",
        "- ⏳ tool_12",
      ].join("\n"),
    );
    expect(fakeClientState.sendStreamText.mock.calls[11]?.[2]).toEqual({
      replyToMessageId: "msg-collapse",
      finish: false,
      nonBlocking: true,
    });
  });

  it("keeps a long step alive with a rotating dot and no elapsed time", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        stepHeartbeatMs: 5000,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-heartbeat",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });

    const before = fakeClientState.sendStreamText.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length > before);
    const firstBeat = fakeClientState.sendStreamText.mock.calls.at(-1)?.[1] as string;
    expect(firstBeat.endsWith(".")).toBe(true);
    expect(firstBeat).not.toMatch(/\d/);

    await vi.advanceTimersByTimeAsync(5000);
    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length > before + 1);
    const secondBeat = fakeClientState.sendStreamText.mock.calls.at(-1)?.[1] as string;
    // Same step line, one more dot: the bubble proves it is alive without a clock.
    expect(secondBeat).toBe(`${firstBeat}.`);
    expect(secondBeat).not.toMatch(/\d/);
  });

  it("sends attachments after the text reply", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-attach",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:dm:user_1",
      text: "Here you go",
      attachments: [{ kind: "image", filePath: "/tmp/image.png" }],
    });

    await waitFor(
      () =>
        fakeClientState.sendStreamText.mock.calls.length === 1 &&
        fakeClientState.sendAttachment.mock.calls.length === 1,
    );

    expect(fakeClientState.sendStreamText.mock.invocationCallOrder[0]).toBeLessThan(
      fakeClientState.sendAttachment.mock.invocationCallOrder[0],
    );
  });

  it("triggers a scheduled task locally on /schedule-run without polluting the core", async () => {
    const onScheduleRun = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      onScheduleRun,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-run",
      text: "/schedule-run report",
      mentionedBot: false,
    });

    expect(onScheduleRun).toHaveBeenCalledWith("report", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Task "report"'),
      "msg-schedule-run",
    );
  });

  it("replies with a localized error for an unknown /schedule-run task", async () => {
    const onScheduleRun = vi.fn(async () => ({ ok: false, reason: "task not found" }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      onScheduleRun,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-run-missing",
      text: "/schedule-run missing",
      mentionedBot: false,
    });

    expect(onScheduleRun).toHaveBeenCalledWith("missing", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Scheduled task "missing" was not found.'),
      "msg-schedule-run-missing",
    );
  });

  it("shows a usage reply for a malformed /schedule-run without calling onScheduleRun", async () => {
    const onScheduleRun = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      onScheduleRun,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-run-bad",
      text: "/schedule-run",
      mentionedBot: false,
    });

    expect(onScheduleRun).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Usage: `/schedule-run <task-name>`"),
      "msg-schedule-run-bad",
    );
  });

  it("binds this chat as a task's target locally on /schedule-here without polluting the core", async () => {
    const onScheduleHere = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      onScheduleHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-here",
      text: "/schedule-here report",
      mentionedBot: false,
    });

    expect(onScheduleHere).toHaveBeenCalledWith("report", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Task "report"'),
      "msg-schedule-here",
    );
    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toContain("send its results to this chat");
  });

  it("replies with a localized error for an unknown /schedule-here task", async () => {
    const onScheduleHere = vi.fn(async () => ({ ok: false, reason: "task not found" }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      onScheduleHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-here-missing",
      text: "/schedule-here missing",
      mentionedBot: false,
    });

    expect(onScheduleHere).toHaveBeenCalledWith("missing", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Scheduled task "missing" was not found.'),
      "msg-schedule-here-missing",
    );
  });

  it("shows a usage reply for a malformed /schedule-here without calling onScheduleHere", async () => {
    const onScheduleHere = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      onScheduleHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-schedule-here-bad",
      text: "/schedule-here",
      mentionedBot: false,
    });

    expect(onScheduleHere).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Usage: `/schedule-here <task-name>`"),
      "msg-schedule-here-bad",
    );
  });

  it("binds this chat as a queue's target locally on /queue-here without polluting the core", async () => {
    const onQueueHere = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      undefined,
      onQueueHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-queue-here",
      text: "/queue-here build",
      mentionedBot: false,
    });

    expect(onQueueHere).toHaveBeenCalledWith("build", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Queue "build"'),
      "msg-queue-here",
    );
    expect(fakeClientState.sendText.mock.calls[0]?.[1]).toContain("is now bound to this chat");
  });

  it("replies with a localized error for an unknown /queue-here queue", async () => {
    const onQueueHere = vi.fn(async () => ({ ok: false, reason: "queue not found" }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      undefined,
      onQueueHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-queue-here-missing",
      text: "/queue-here missing",
      mentionedBot: false,
    });

    expect(onQueueHere).toHaveBeenCalledWith("missing", "wecom:dm:user_1");
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining('Queue "missing" was not found.'),
      "msg-queue-here-missing",
    );
  });

  it("shows a usage reply for a malformed /queue-here without calling onQueueHere", async () => {
    const onQueueHere = vi.fn(async () => ({ ok: true }));
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
      undefined,
      undefined,
      undefined,
      undefined,
      onQueueHere,
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-queue-here-bad",
      text: "/queue-here",
      mentionedBot: false,
    });

    expect(onQueueHere).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Usage: `/queue-here <queue-name>`"),
      "msg-queue-here-bad",
    );
  });

  it("degrades gracefully when onQueueHere is absent: logs and replies nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new WecomIMAdapter(
        {
          botId: "bot-id",
          secret: "secret",
          requireMentionInGroup: true,
        },
        createLogger("test"),
      );
      const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

      await adapter.start(onOutput);
      await fakeClientState.onMessage?.({
        chatId: "user_1",
        chatType: "dm",
        messageId: "msg-queue-here-no-bridge",
        text: "/queue-here build",
        mentionedBot: false,
      });

      expect(onOutput).not.toHaveBeenCalled();
      expect(fakeClientState.sendText).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("onQueueHere is not injected")),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("degrades gracefully when onScheduleHere is absent: logs and replies nothing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const adapter = new WecomIMAdapter(
        {
          botId: "bot-id",
          secret: "secret",
          requireMentionInGroup: true,
        },
        createLogger("test"),
      );
      const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

      await adapter.start(onOutput);
      await fakeClientState.onMessage?.({
        chatId: "user_1",
        chatType: "dm",
        messageId: "msg-schedule-here-no-bridge",
        text: "/schedule-here report",
        mentionedBot: false,
      });

      expect(onOutput).not.toHaveBeenCalled();
      expect(fakeClientState.sendText).not.toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("onScheduleHere is not injected")),
      )).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("replies with the local resume usage hint on a bare /resume without emitting an event", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-resume-usage",
      text: "/resume",
      mentionedBot: false,
    });

    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("Usage: `/resume <provider-session-id>`"),
      "msg-resume-usage",
    );
  });

  it("holds answer text back from the bubble until the run settles", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-delta",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hel",
    });
    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hello world",
    });

    // Answer text is collected, not rendered: the bubble keeps showing the
    // step so the result can land in one piece on settle.
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();

    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe("Hello world");
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("streams answer text into the bubble when streamAnswer is enabled", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        streamAnswer: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-delta",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hel",
    });
    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hello world",
    });

    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length === 2);

    // Every frame carries the whole run text: stream.content is overwrite-only.
    expect(fakeClientState.sendStreamText.mock.calls[1]?.[1]).toBe("Hello world");
    expect(fakeClientState.sendStreamText.mock.calls[1]?.[2]).toEqual({
      replyToMessageId: "msg-delta",
      finish: false,
      nonBlocking: true,
    });
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("does not repeat streamed text and closes the bubble on agent.run.settled", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-delta-settle",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();
    fakeClientState.sendText.mockClear();

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hello world",
    });
    // Real ordering is delta -> message_end -> agent_settled; the completion
    // event must stay silent because the text already reached the bubble.
    await adapter.input({
      type: "assistant.message",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Hello world",
      attachments: [],
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );

    expect(fakeClientState.sendText).not.toHaveBeenCalled();
    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe("Hello world");
    expect(finished?.[2]).toEqual({ replyToMessageId: "msg-delta-settle", finish: true });
  });

  it("replaces every step line with the answer and hides half-received MEDIA markers", async () => {
    // Opening line and step line draw different variants, so the step frame is
    // guaranteed to differ from the announcement and must be sent.
    let picks = 0;
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        stepRandom: () => (picks++ === 0 ? 0 : 0.99),
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-delta-media",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      text: undefined,
    });
    // While the agent works the bubble is the only sign of life.
    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length === 1);
    expect(isStepOfPool("progress.steps.pool", fakeClientState.sendStreamText.mock.calls[0]?.[1])).toBe(
      true,
    );
    expect(fakeClientState.sendStreamText.mock.calls[0]?.[1]).not.toContain("bash");

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Done. MEDIA:/tmp/report.p",
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );

    // The closing frame overwrites the bubble: step lines and the half-received
    // MEDIA marker are both gone, leaving only what the user asked for.
    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe("Done.");
  });

  it("never repeats progress lines in the final frame", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-delta-final",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "All done.",
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );

    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe("All done.");
  });

  it("does not resend a frame whose body has not changed", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        // Log mode gives a deterministic step line, so the first frame is
        // guaranteed to differ from the random opening line.
        replyProgress: "log",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-same-body",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    await adapter.input({
      type: "assistant.tool.update",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    await adapter.input({
      type: "assistant.tool.update",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });

    // Running and update carry the same line for one call, so only the first
    // frame goes out. Everything else would be a repaint of the same text.
    expect(fakeClientState.sendStreamText).toHaveBeenCalledTimes(1);
  });

  it("keeps one bubble when a second message steers the active run", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-first",
      text: "hello",
      mentionedBot: false,
    });
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-second",
      text: "and also this",
      mentionedBot: false,
    });

    // Both messages reach the agent, but only one bubble exists: a second
    // messageId would allocate a second streamId and strand the first bubble.
    expect(onOutput).toHaveBeenCalledTimes(2);
    const replyIds = new Set(
      fakeClientState.sendStreamText.mock.calls.map((call) => call[2]?.replyToMessageId),
    );
    expect(replyIds).toEqual(new Set(["msg-first"]));

    // The follow-up is acknowledged inside the same bubble, not as a new message.
    expect(fakeClientState.sendStreamText).toHaveBeenCalledTimes(2);
    expect(
      containsStepVariant("progress.steps.steered", fakeClientState.sendStreamText.mock.calls.at(-1)?.[1]),
    ).toBe(true);
  });

  it("stops refreshing the bubble when the heartbeat is disabled", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        stepHeartbeatMs: 0,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-no-heartbeat",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    const before = fakeClientState.sendStreamText.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60000);
    // No heartbeat frame was added, whether or not the step frame itself landed.
    expect(fakeClientState.sendStreamText).toHaveBeenCalledTimes(before);
  });

  it("shows a status note after a step instead of the tool output", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-step-result",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    const runningCount = fakeClientState.sendStreamText.mock.calls.length;

    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
      result: "build ok / output 448 KB",
    });

    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length > runningCount);
    const doneBody = fakeClientState.sendStreamText.mock.calls.at(-1)?.[1] as string;
    expect(containsStepVariant("progress.steps.stepDone", doneBody)).toBe(true);
    // The tool's own output never reaches the bubble.
    expect(doneBody).not.toContain("build ok");
    expect(doneBody).not.toContain("output 448 KB");
    expect(doneBody).not.toContain("Result:");

    const doneCount = fakeClientState.sendStreamText.mock.calls.length;
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "read",
      toolCallId: "call-2",
    });

    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length > doneCount);
    const nextBody = fakeClientState.sendStreamText.mock.calls.at(-1)?.[1] as string;
    // The next step starts from a clean line: the previous note is gone.
    expect(containsStepVariant("progress.steps.stepDone", nextBody)).toBe(false);
  });

  it("shows a truncated excerpt only when stepResultDetail is raw", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        stepResultDetail: "raw",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-step-result-long",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    const result = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
      result,
    });

    await waitFor(() => fakeClientState.sendStreamText.mock.calls.length === 1);
    const body = fakeClientState.sendStreamText.mock.calls[0]?.[1] as string;
    expect(body).toContain("Result: line 0");
    expect(body).toContain("line 2");
    expect(body).not.toContain("line 3");
    expect(body).toContain("…");
  });

  it("keeps the step note out of the bubble when showStepResult is false", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        showStepResult: false,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-step-result-off",
      text: "hello",
      mentionedBot: false,
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.tool.done",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      toolName: "bash",
      toolCallId: "call-1",
      result: "build ok",
    });

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "All done",
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    // The closing frame always lands, so this does not depend on whether the
    // random step line happened to match the opening line.
    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    for (const call of fakeClientState.sendStreamText.mock.calls) {
      const body = call[1] as string;
      expect(containsStepVariant("progress.steps.stepDone", body)).toBe(false);
      expect(body).not.toContain("build ok");
    }
  });

  it("drops an inbound message with no text instead of running the agent", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-empty",
      text: "   ",
      mentionedBot: false,
    });

    // An empty prompt would burn a whole agent turn on nothing.
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();
  });

  it("reopens the bubble when the old stream can no longer be finished", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-reopen",
      text: "hello",
      mentionedBot: false,
    });

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      text: "Final answer",
    });

    let finishAttempts = 0;
    fakeClientState.sendStreamText.mockImplementation(
      async (_chatId: string, _text: string, options?: { finish?: boolean }) => {
        if (options?.finish !== true) {
          return;
        }
        finishAttempts += 1;
        if (finishAttempts === 1) {
          throw new Error("stream already closed by the server");
        }
      },
    );

    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() => finishAttempts >= 2);
    // The answer landed in a fresh bubble, not as a second chat message.
    expect(finishAttempts).toBe(2);
    expect(fakeClientState.sendText).not.toHaveBeenCalled();
  });

  it("sends at most one delivery-failure notice per cooldown window", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-cooldown",
      text: "hello",
      mentionedBot: false,
    });

    fakeClientState.sendText.mockRejectedValue(new Error("boom"));
    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.run.failed",
      detail: "first",
    });
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 2);

    fakeClientState.sendText.mockClear();
    await adapter.input({
      type: "error",
      clientSessionId: "wecom:dm:user_1",
      kind: "agent.run.failed",
      detail: "second",
    });
    await waitFor(() => fakeClientState.sendText.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Only the error body went out; the notice is inside its cooldown window.
    expect(fakeClientState.sendText).toHaveBeenCalledTimes(1);
  });

  it("drains egress queues per session so a slow chat does not block another", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_a",
      chatType: "dm",
      messageId: "msg-a",
      text: "hello a",
      mentionedBot: false,
    });
    await fakeClientState.onMessage?.({
      chatId: "user_b",
      chatType: "dm",
      messageId: "msg-b",
      text: "hello b",
      mentionedBot: false,
    });

    const delivered: string[] = [];
    let releaseA: (() => void) | undefined;
    // The gate exists before any frame arrives, so the test can always release
    // chat A regardless of scheduling order.
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    fakeClientState.sendStreamText.mockImplementation(async (chatId: string) => {
      if (chatId === "user_a") {
        await aGate;
        delivered.push("a");
        return;
      }
      delivered.push("b");
    });

    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_a",
      agentSessionId: "agent-a",
      toolName: "bash",
      toolCallId: "call-a",
    });
    await adapter.input({
      type: "assistant.tool.running",
      clientSessionId: "wecom:dm:user_b",
      agentSessionId: "agent-b",
      toolName: "bash",
      toolCallId: "call-b",
    });

    // Chat B is delivered while chat A is still stuck in its send.
    await waitFor(() => delivered.includes("b"));
    expect(delivered).not.toContain("a");

    releaseA?.();
    await waitFor(() => delivered.includes("a"));
  });

  it("tells the agent who is speaking in a group, using labels when configured", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        userLabels: { "u-1": "张三" },
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);

    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-group-1",
      text: "看下这个",
      mentionedBot: true,
      senderId: "u-2",
    });
    expect(onOutput).toHaveBeenLastCalledWith({
      type: "user.message",
      clientSessionId: "wecom:group:group_1",
      text: "[speaker: u-2]\n看下这个",
    });

    // A mapped id becomes a readable name.
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-group-2",
      text: "我也是",
      mentionedBot: true,
      senderId: "u-1",
    });
    expect(onOutput).toHaveBeenLastCalledWith({
      type: "user.message",
      clientSessionId: "wecom:group:group_1",
      text: "[speaker: 张三]\n我也是",
    });

    // Direct messages have exactly one possible speaker, so no line is added.
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-dm-1",
      text: "你好",
      mentionedBot: false,
      senderId: "u-1",
    });
    expect(onOutput).toHaveBeenLastCalledWith({
      type: "user.message",
      clientSessionId: "wecom:dm:user_1",
      text: "你好",
    });
  });

  it("mentions the asker in a group reply, and leaves direct messages alone", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        mentionSender: "markdown",
      },
      createLogger("test"),
    );

    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-mention",
      text: "看下这个",
      mentionedBot: true,
      senderId: "u-2",
    });

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-1",
      text: "已经看过了",
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-1",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    const finished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(finished?.[1]).toBe("<@u-2> 已经看过了");

    // A direct message has nobody to point at.
    await adapter.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-dm-mention",
      text: "你好",
      mentionedBot: false,
      senderId: "u-1",
    });
    fakeClientState.sendStreamText.mockClear();

    await adapter.input({
      type: "assistant.delta",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-2",
      text: "你好呀",
    });
    await adapter.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:dm:user_1",
      agentSessionId: "agent-2",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    const dmFinished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(dmFinished?.[1]).toBe("你好呀");
  });

  it("can fall back to a literal @label or to no mention at all", async () => {
    const textMode = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        mentionSender: "text",
        userLabels: { "u-2": "张三" },
      },
      createLogger("test"),
    );

    await textMode.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-mention-text",
      text: "看下这个",
      mentionedBot: true,
      senderId: "u-2",
    });
    await textMode.input({
      type: "assistant.delta",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-3",
      text: "好的",
    });
    await textMode.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-3",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    const textFinished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(textFinished?.[1]).toBe("@张三 好的");

    const noMention = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
        mentionSender: "none",
      },
      createLogger("test"),
    );

    fakeClientState.sendStreamText.mockClear();
    await noMention.start(async () => {});
    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-mention-none",
      text: "看下这个",
      mentionedBot: true,
      senderId: "u-2",
    });
    await noMention.input({
      type: "assistant.delta",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-4",
      text: "好的",
    });
    await noMention.input({
      type: "agent.run.settled",
      clientSessionId: "wecom:group:group_1",
      agentSessionId: "agent-4",
      aborted: false,
    });

    await waitFor(() =>
      fakeClientState.sendStreamText.mock.calls.some((call) => call[2]?.finish === true),
    );
    const noneFinished = fakeClientState.sendStreamText.mock.calls.find((call) => call[2]?.finish === true);
    expect(noneFinished?.[1]).toBe("好的");
  });

  it("puts the quoted message into the prompt on one line", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async () => {});

    await adapter.start(onOutput);

    await fakeClientState.onMessage?.({
      chatId: "group_1",
      chatType: "group",
      messageId: "msg-quoted",
      text: "这个怎么办",
      mentionedBot: true,
      senderId: "u-2",
      quotedText: "上一版报错：\nTypeError: boom",
    });

    expect(onOutput).toHaveBeenLastCalledWith({
      type: "user.message",
      clientSessionId: "wecom:group:group_1",
      text: "[speaker: u-2]\n[quoted: 上一版报错： / TypeError: boom]\n这个怎么办",
    });
  });

  it("answers a malformed /think locally without opening a bubble", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-think-usage",
      text: "/think",
      mentionedBot: false,
    });

    // No session is created, no bubble is opened: just the usage line.
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("/think <level>"),
      "msg-think-usage",
    );

    fakeClientState.sendText.mockClear();
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-think-bad",
      text: "/think turbo",
      mentionedBot: false,
    });
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();
    expect(fakeClientState.sendText).toHaveBeenCalledWith(
      "user_1",
      expect.stringContaining("/think <level>"),
      "msg-think-bad",
    );
  });

  it("forwards a well-formed /think to the core", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-think-set",
      text: "/think high",
      mentionedBot: false,
    });

    expect(onOutput).toHaveBeenCalledWith({
      type: "command.session.thinking.set",
      clientSessionId: "wecom:dm:user_1",
      level: "high",
    });
  });

  it("merges a file and the sentence that follows it into one prompt", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);

    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-file",
      text: "[Received file: /tmp/report.pdf]",
      mentionedBot: false,
      hasUserText: false,
    });

    // Held back: no bubble, no run, nothing to answer yet.
    expect(onOutput).not.toHaveBeenCalled();
    expect(fakeClientState.sendStreamText).not.toHaveBeenCalled();

    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-explain",
      text: "看下这个报告",
      mentionedBot: false,
      hasUserText: true,
    });

    await waitFor(() => onOutput.mock.calls.length === 1);
    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "wecom:dm:user_1",
      text: "[Received file: /tmp/report.pdf]\n看下这个报告",
    });
    // One run, one bubble.
    expect(fakeClientState.sendStreamText).toHaveBeenCalledTimes(1);
  });

  it("sends a lone attachment once the merge window expires", async () => {
    vi.useFakeTimers();

    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-lone-file",
      text: "[Received image: /tmp/shot.png]",
      mentionedBot: false,
      hasUserText: false,
    });
    expect(onOutput).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    await waitFor(() => onOutput.mock.calls.length === 1);
    expect(onOutput).toHaveBeenCalledWith({
      type: "user.message",
      clientSessionId: "wecom:dm:user_1",
      text: "[Received image: /tmp/shot.png]",
    });
  });

  it("flushes a pending attachment instead of merging it into a command", async () => {
    const adapter = new WecomIMAdapter(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onOutput = vi.fn(async (_event: ClientOutputEvent) => {});

    await adapter.start(onOutput);

    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-file-before-command",
      text: "[Received file: /tmp/spec.md]",
      mentionedBot: false,
      hasUserText: false,
    });
    await fakeClientState.onMessage?.({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-command",
      text: "/status",
      mentionedBot: false,
      hasUserText: true,
    });

    await waitFor(() => onOutput.mock.calls.length === 2);
    expect(onOutput.mock.calls.map((call) => call[0]?.type)).toEqual([
      "user.message",
      "command.session.status",
    ]);
    expect(onOutput.mock.calls[0]?.[0]).toMatchObject({
      text: "[Received file: /tmp/spec.md]",
    });
  });
});
