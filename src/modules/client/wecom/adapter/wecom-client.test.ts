import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../../../core/logger";
import type { OutboundAttachment } from "../../../../types";
import { WECOM_WELCOME_REPLIES, WecomClient } from "./wecom-client";

type MockFrame = {
  headers: { req_id: string };
  body: Record<string, any>;
  errcode?: number;
  errmsg?: string;
};

const sdkMock = vi.hoisted(() => {
  class MockWSClient {
    static instances: MockWSClient[] = [];

    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
    readonly sendMessage = vi.fn(async () => ({ errcode: 0 }));
    readonly reply = vi.fn(async () => ({ errcode: 0 }));
    readonly replyStream = vi.fn(async () => ({ errcode: 0 }));
    readonly uploadMedia = vi.fn(async (_buffer: Buffer, options: { type: string }) => ({
      media_id: `${options.type}-media-id`,
    }));
    readonly replyMedia = vi.fn(async () => ({ errcode: 0 }));
    readonly replyWelcome = vi.fn(async () => ({ errcode: 0 }));
    readonly downloadFile = vi.fn(async () => ({
      buffer: Buffer.from("downloaded"),
      filename: "downloaded.bin",
    }));
    connect = vi.fn(() => this);
    disconnect = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockWSClient.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void): this {
      const handlers = this.handlers.get(event) ?? new Set();
      handlers.add(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    MockWSClient,
    generateReqId: vi.fn((prefix = "req") => `${prefix}-generated`),
  };
});

vi.mock("@wecom/aibot-node-sdk", () => ({
  WSClient: sdkMock.MockWSClient,
  generateReqId: sdkMock.generateReqId,
}));

function latestClient(): InstanceType<typeof sdkMock.MockWSClient> {
  const client = sdkMock.MockWSClient.instances.at(-1);
  if (!client) {
    throw new Error("expected SDK client instance");
  }
  return client;
}

async function waitFor(condition: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition not met in time");
}

describe("WecomClient", () => {
  beforeEach(() => {
    sdkMock.MockWSClient.instances.length = 0;
    sdkMock.generateReqId.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects through the SDK and emits inbound text messages", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    expect(sdkClient.connect).toHaveBeenCalled();
    expect(sdkClient.options).toMatchObject({
      botId: "bot-id",
      secret: "secret",
      wsUrl: "wss://openws.work.weixin.qq.com",
    });

    sdkClient.emit("message.text", {
      headers: { req_id: "req-in-1" },
      body: {
        msgid: "msg-1",
        chattype: "single",
        from: { userid: "user_1" },
        text: { content: "hello" },
        msgtype: "text",
      },
    } satisfies MockFrame);

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "user_1",
      chatType: "dm",
      messageId: "msg-1",
      text: "hello",
      mentionedBot: false,
      senderId: "user_1",
      raw: expect.any(Object),
    });
  });

  it("handles the SDK generic message event for types without a specific event", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    latestClient().emit("message", {
      headers: { req_id: "req-in-generic-1" },
      body: {
        msgid: "msg-generic-1",
        chattype: "single",
        from: { userid: "user_generic" },
        appmsg: { title: "hello from generic" },
        msgtype: "appmsg",
      },
    } satisfies MockFrame);

    expect(onMessage).toHaveBeenCalledWith({
      chatId: "user_generic",
      chatType: "dm",
      messageId: "msg-generic-1",
      text: "hello from generic",
      mentionedBot: false,
      senderId: "user_generic",
      raw: expect.any(Object),
    });
  });

  it("ignores the SDK generic message event when a specific event also fires", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const frame = {
      headers: { req_id: "req-in-dup-1" },
      body: {
        msgid: "msg-dup-1",
        chattype: "single",
        from: { userid: "user_dup" },
        text: { content: "hello" },
        msgtype: "text",
      },
    } satisfies MockFrame;

    latestClient().emit("message", frame);
    latestClient().emit("message.text", frame);

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("deduplicates redelivered inbound callbacks by msgid", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const frame = {
      headers: { req_id: "req-in-redelivered-1" },
      body: {
        msgid: "msg-redelivered-1",
        chattype: "single",
        from: { userid: "user_redelivered" },
        text: { content: "hello again" },
        msgtype: "text",
      },
    } satisfies MockFrame;

    latestClient().emit("message.text", frame);
    latestClient().emit("message.text", frame);
    await waitFor(() => onMessage.mock.calls.length >= 1);

    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("marks the client as kicked on disconnected_event and rejects sends", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onKicked = vi.fn();
    client.setOnKicked(onKicked);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    expect(client.isKicked()).toBe(false);

    latestClient().emit("event.disconnected_event", {
      headers: { req_id: "req-kicked-1" },
      body: {
        msgid: "msg-kicked-1",
        msgtype: "event",
        event: { eventtype: "disconnected_event" },
      },
    } satisfies MockFrame);

    expect(client.isKicked()).toBe(true);
    expect(onKicked).toHaveBeenCalledTimes(1);
    await expect(client.sendText("user_1", "hello")).rejects.toThrow("newer connection");
    await expect(client.sendStreamText("user_1", "hello")).rejects.toThrow("newer connection");
  });

  it("surfaces SDK connection errors with endpoint context", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
        websocketUrl: "wss://openws.work.weixin.qq.com",
      },
      createLogger("test"),
    );

    const connecting = client.connect();
    latestClient().emit("error", new Error("socket refused"));

    await expect(connecting).rejects.toThrow(
      "WeCom websocket connect failed (wss://openws.work.weixin.qq.com): socket refused",
    );
  });

  it("detects group mentions and appends downloaded image paths", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    sdkClient.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("hello-image"),
      filename: "image.png",
    });
    sdkClient.emit("message.image", {
      headers: { req_id: "req-group-1" },
      body: {
        msgid: "msg-2",
        chatid: "group_1",
        chattype: "group",
        from: { userid: "user_2" },
        msgtype: "image",
        text: { content: "@Bot please inspect this" },
        image: { url: "https://example.com/image.png", aeskey: "aes-key" },
      },
    } satisfies MockFrame);

    await waitFor(() => onMessage.mock.calls.length === 1);

    const message = onMessage.mock.calls[0]?.[0] as { text: string; mentionedBot: boolean };
    expect(message.mentionedBot).toBe(true);
    expect(message.text).toContain("please inspect this");
    const match = message.text.match(/\[Received image: (.+)\]/);
    expect(match?.[1]).toBeTruthy();
    expect(existsSync(match![1]!)).toBe(true);
    rmSync(match![1]!, { force: true });
    expect(sdkClient.downloadFile).toHaveBeenCalledWith("https://example.com/image.png", "aes-key");
  });

  it("uses reply mode when reply context exists and falls back to proactive send", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    sdkClient.emit("message.text", {
      headers: { req_id: "req-reply-1" },
      body: {
        msgid: "msg-3",
        chattype: "single",
        from: { userid: "user_1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    } satisfies MockFrame);

    await client.sendText("user_1", "hi back", "msg-3");
    expect(sdkClient.reply).toHaveBeenCalledWith(
      { headers: { req_id: "req-reply-1" } },
      {
        msgtype: "markdown",
        markdown: { content: "hi back" },
      },
    );
    expect(sdkClient.sendMessage).not.toHaveBeenCalledWith("user_1", expect.anything());

    sdkClient.sendMessage.mockRejectedValueOnce(new Error("reply failed"));
    await expect(client.sendText("user_2", "proactive")).rejects.toThrow("reply failed");
    expect(sdkClient.sendMessage).toHaveBeenLastCalledWith("user_2", {
      msgtype: "markdown",
      markdown: { content: "proactive" },
    });
  });

  it("uses replyStream with the same stream id for incremental updates", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    sdkClient.emit("message.text", {
      headers: { req_id: "req-stream-1" },
      body: {
        msgid: "msg-stream-1",
        chattype: "single",
        from: { userid: "user_1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    } satisfies MockFrame);

    await client.sendStreamText("user_1", "正在处理中...", {
      replyToMessageId: "msg-stream-1",
      finish: false,
      feedbackId: "feedback-1",
    });
    await client.sendStreamText("user_1", "处理完成", {
      replyToMessageId: "msg-stream-1",
      finish: true,
    });

    expect(sdkClient.replyStream).toHaveBeenCalledTimes(2);
    const firstCall = sdkClient.replyStream.mock.calls[0];
    const secondCall = sdkClient.replyStream.mock.calls[1];
    expect(firstCall?.[0]).toEqual({ headers: { req_id: "req-stream-1" } });
    expect(firstCall?.[2]).toBe("正在处理中...");
    expect(firstCall?.[3]).toBe(false);
    expect(firstCall?.[5]).toEqual({ id: "feedback-1" });
    expect(secondCall?.[0]).toEqual({ headers: { req_id: "req-stream-1" } });
    expect(secondCall?.[1]).toBe(firstCall?.[1]);
    expect(secondCall?.[2]).toBe("处理完成");
    expect(secondCall?.[3]).toBe(true);
    expect(secondCall?.[5]).toBeUndefined();
  });

  it("uploads attachments and sends a native image message", async () => {
    const filePath = join(tmpdir(), `wecom-client-test-${Date.now()}.png`);
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(filePath, pngBytes);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    sdkClient.emit("message.text", {
      headers: { req_id: "req-attachment-1" },
      body: {
        msgid: "msg-attachment-1",
        chattype: "single",
        from: { userid: "user_1" },
        msgtype: "text",
        text: { content: "hello" },
      },
    } satisfies MockFrame);

    await client.sendAttachment(
      "user_1",
      { kind: "image", filePath } satisfies OutboundAttachment,
      "msg-attachment-1",
    );

    expect(sdkClient.uploadMedia).toHaveBeenCalled();
    expect(sdkClient.replyMedia).toHaveBeenCalledWith(
      { headers: { req_id: "req-attachment-1" } },
      "image",
      "image-media-id",
    );

    rmSync(filePath, { force: true });
  });

  it("replies with a welcome message on enter_chat events", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    sdkClient.emit("event.enter_chat", {
      headers: { req_id: "req-enter-1" },
      body: {
        event: { eventtype: "enter_chat" },
        from: { userid: "user_1" },
      },
    } satisfies MockFrame);

    await waitFor(() => sdkClient.replyWelcome.mock.calls.length === 1);

    const [frame, payload] = sdkClient.replyWelcome.mock.calls[0] as [
      { headers: { req_id: string } },
      { msgtype: string; text: { content: string } },
    ];
    expect(frame).toEqual({ headers: { req_id: "req-enter-1" } });
    expect(payload.msgtype).toBe("text");
    expect(WECOM_WELCOME_REPLIES as readonly string[]).toContain(payload.text.content);
  });

  it("rotates the welcome reply pool on every enter_chat event", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    // Deterministic pick order: 0.5 walks the pool so every reply appears once.
    const randomSpy = vi.spyOn(Math, "random");
    for (let i = 0; i < WECOM_WELCOME_REPLIES.length; i += 1) {
      randomSpy.mockReturnValueOnce((i + 0.5) / WECOM_WELCOME_REPLIES.length);
      sdkClient.emit("event.enter_chat", {
        headers: { req_id: `req-enter-${i}` },
        body: {
          event: { eventtype: "enter_chat" },
          from: { userid: "user_1" },
        },
      } satisfies MockFrame);
    }

    await waitFor(() => sdkClient.replyWelcome.mock.calls.length === WECOM_WELCOME_REPLIES.length);

    const contents = sdkClient.replyWelcome.mock.calls.map(
      (call) => (call as unknown as [unknown, { text: { content: string } }])[1].text.content,
    );
    expect(contents).toEqual([...WECOM_WELCOME_REPLIES]);
    randomSpy.mockRestore();
  });

  it("uploads attachments and proactively sends when no reply context exists", async () => {
    const filePath = join(tmpdir(), `wecom-client-test-${Date.now()}.png`);
    const pngBytes = Buffer.from("89504e470d0a1a0a", "hex");
    writeFileSync(filePath, pngBytes);

    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    client.setOnMessage(async () => {});

    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;

    const sdkClient = latestClient();
    await client.sendAttachment("user_1", { kind: "image", filePath } satisfies OutboundAttachment);

    expect(sdkClient.uploadMedia).toHaveBeenCalled();
    expect(sdkClient.sendMessage).toHaveBeenCalledWith("user_1", {
      msgtype: "image",
      image: { media_id: "image-media-id" },
    });

    rmSync(filePath, { force: true });
  });

  it("only counts an @ of the configured bot name as a mention", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
        botName: "瓦达西",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);
    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;
    const sdkClient = latestClient();

    const emitGroupText = async (messageId: string, content: string) => {
      sdkClient.emit("message.text", {
        headers: { req_id: `req-${messageId}` },
        body: {
          msgid: messageId,
          chatid: "group_1",
          chattype: "group",
          from: { userid: "user_2" },
          msgtype: "text",
          text: { content },
        },
      } satisfies MockFrame);
      await waitFor(() => onMessage.mock.calls.length === 1);
      const message = onMessage.mock.calls[0]?.[0] as { text: string; mentionedBot: boolean };
      onMessage.mockClear();
      return message;
    };

    // Someone else's @ is not a call to this bot.
    const other = await emitGroupText("msg-other", "@张三 你看下这个");
    expect(other.mentionedBot).toBe(false);
    expect(other.text).toBe("@张三 你看下这个");

    // This bot first, then someone else: the other @ is not part of the prompt.
    const mixed = await emitGroupText("msg-mixed", "@瓦达西 @张三 帮忙看下");
    expect(mixed.mentionedBot).toBe(true);
    expect(mixed.text).toBe("帮忙看下");

    // Someone else first, then this bot: still a mention, still stripped.
    const trailing = await emitGroupText("msg-trailing", "@张三 @瓦达西 看下");
    expect(trailing.mentionedBot).toBe(true);
    expect(trailing.text).toBe("看下");
  });

  it("matches a mention whether or not the display name carries its alias", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
        botName: "瓦达西(Vaddasi)",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);
    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;
    const sdkClient = latestClient();

    const emitGroupText = async (messageId: string, content: string) => {
      sdkClient.emit("message.text", {
        headers: { req_id: `req-${messageId}` },
        body: {
          msgid: messageId,
          chatid: "group_1",
          chattype: "group",
          from: { userid: "user_2" },
          msgtype: "text",
          text: { content },
        },
      } satisfies MockFrame);
      await waitFor(() => onMessage.mock.calls.length === 1);
      const message = onMessage.mock.calls[0]?.[0] as { text: string; mentionedBot: boolean };
      onMessage.mockClear();
      return message;
    };

    const withAlias = await emitGroupText("msg-alias", "@瓦达西(Vaddasi) 帮忙看下");
    expect(withAlias.mentionedBot).toBe(true);
    expect(withAlias.text).toBe("帮忙看下");

    // Same bot, rendered without the alias by some clients.
    const withoutAlias = await emitGroupText("msg-no-alias", "@瓦达西 帮忙看下");
    expect(withoutAlias.mentionedBot).toBe(true);
    expect(withoutAlias.text).toBe("帮忙看下");

    // Base names match on purpose: a client that renders a different alias must
    // not make the bot deaf. The cost is that a same-named sibling bot would be
    // treated as this one.
    const sibling = await emitGroupText("msg-other-alias", "@瓦达西(Other) 帮忙看下");
    expect(sibling.mentionedBot).toBe(true);
  });

  it("passes a quoted message through as text", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);
    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;
    const sdkClient = latestClient();

    sdkClient.emit("message.text", {
      headers: { req_id: "req-quote-1" },
      body: {
        msgid: "msg-quote-1",
        chattype: "group",
        chatid: "group_1",
        from: { userid: "u-2" },
        msgtype: "text",
        text: { content: "@Bot 这个怎么办" },
        quote: {
          msgtype: "text",
          text: { content: "上一版的报错日志在这里" },
        },
      },
    } satisfies MockFrame);

    await waitFor(() => onMessage.mock.calls.length === 1);
    const message = onMessage.mock.calls[0]?.[0] as { quotedText?: string };
    expect(message.quotedText).toBe("上一版的报错日志在这里");

    // Media quotes are named, not downloaded: the agent only needs to know what was cited.
    sdkClient.emit("message.text", {
      headers: { req_id: "req-quote-2" },
      body: {
        msgid: "msg-quote-2",
        chattype: "group",
        chatid: "group_1",
        from: { userid: "u-2" },
        msgtype: "text",
        text: { content: "@Bot 看这个图" },
        quote: {
          msgtype: "image",
          image: { url: "https://example.com/a.png" },
        },
      },
    } satisfies MockFrame);

    await waitFor(() => onMessage.mock.calls.length === 2);
    const mediaMessage = onMessage.mock.calls[1]?.[0] as { quotedText?: string };
    expect(mediaMessage.quotedText).toBe("[image]");
  });

  it("downloads media items carried inside a mixed message", async () => {
    const client = new WecomClient(
      {
        botId: "bot-id",
        secret: "secret",
        requireMentionInGroup: true,
      },
      createLogger("test"),
    );
    const onMessage = vi.fn(async () => {});
    client.setOnMessage(onMessage);
    const connecting = client.connect();
    latestClient().emit("authenticated");
    await connecting;
    const sdkClient = latestClient();

    sdkClient.downloadFile.mockResolvedValueOnce({
      buffer: Buffer.from("image-bytes"),
      filename: "shot.png",
    });

    sdkClient.emit("message.mixed", {
      headers: { req_id: "req-mixed-1" },
      body: {
        msgid: "msg-mixed-1",
        chatid: "group_1",
        chattype: "group",
        from: { userid: "u-2" },
        msgtype: "mixed",
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "@Bot 看下这张图" } },
            { msgtype: "image", image: { url: "https://example.com/shot.png", aeskey: "k1" } },
          ],
        },
      },
    } satisfies MockFrame);

    await waitFor(() => onMessage.mock.calls.length === 1);
    const message = onMessage.mock.calls[0]?.[0] as { text: string };
    expect(message.text).toContain("看下这张图");

    const match = message.text.match(/\[Received image: (.+)\]/);
    expect(match?.[1]).toBeTruthy();
    expect(existsSync(match![1]!)).toBe(true);
    rmSync(match![1]!, { force: true });
    expect(sdkClient.downloadFile).toHaveBeenCalledWith("https://example.com/shot.png", "k1");
  });
});
