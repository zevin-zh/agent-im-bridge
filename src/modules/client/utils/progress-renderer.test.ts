import { describe, expect, it } from "vitest";
import { getTranslator } from "../../../i18n";
import { ProgressRenderer, type ProgressEvent } from "./progress-renderer";
import type { ClientInputEvent } from "../../../types";

describe("ProgressRenderer", () => {
  it("reports assistant.message and assistant.thinking as non-progress events", () => {
    const renderer = new ProgressRenderer();

    expect(
      renderer.isProgressEvent({
        type: "assistant.message",
        clientSessionId: "s1",
        text: "hi",
      }),
    ).toBe(false);
    expect(
      renderer.isProgressEvent({
        type: "assistant.thinking",
        clientSessionId: "s1",
        text: "Planning",
      }),
    ).toBe(false);
  });

  it("reports tool and compacting events as progress events", () => {
    const renderer = new ProgressRenderer();
    const events: ClientInputEvent[] = [
      { type: "session.compacting", clientSessionId: "s1" },
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.update", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" },
    ];

    for (const event of events) {
      expect(renderer.isProgressEvent(event)).toBe(true);
    }
  });

  it("renders an English placeholder when no progress has been recorded", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    expect(renderer.getCurrentProgress()).toEqual({
      markdown: "No progress yet.",
      status: "running",
      collapsedCount: 0,
      isEmpty: true,
    });
  });

  it("renders a Chinese placeholder when no progress has been recorded", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("zh-CN") });

    expect(renderer.getCurrentProgress()).toEqual({
      markdown: "暂无进度。",
      status: "running",
      collapsedCount: 0,
      isEmpty: true,
    });
  });

  it("formats tool and compacting lines with status icons in English", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });
    const events: ProgressEvent[] = [
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "web_search" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash", text: "permission denied" },
      { type: "session.compacting", clientSessionId: "s1", text: "trimming history" },
    ];

    for (const event of events) {
      renderer.takeProgressEvent(event);
    }

    const progress = renderer.getCurrentProgress();
    expect(progress.markdown).toBe(
      ["- ⏳ web_search", "- ✅ bash", "- ❌ bash: permission denied", "- Compacting session: trimming history"].join(
        "\n",
      ),
    );
    expect(progress.status).toBe("running");
    expect(progress.collapsedCount).toBe(0);
  });

  it("renders tool errors without synthetic dedupe logic", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().markdown).toBe("- ❌ bash");

    const renderer2 = new ProgressRenderer({ t: getTranslator("en-US") });
    renderer2.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "permission denied",
    });
    expect(renderer2.getCurrentProgress().markdown).toBe("- ❌ bash: permission denied");
  });

  it("renders tool labels on error lines with a longer visible label before truncation", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "read",
      toolCallId: "call-1",
      toolLabel: "/home/leefoundy/demo.txt",
    });

    expect(renderer.getCurrentProgress().markdown).toBe("- ❌ read: /home/leefoundy/demo.txt");
  });

  it("updates the same tool row in place when toolCallId is present", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- ⏳ bash: ls -la");

    renderer.takeProgressEvent({
      type: "assistant.tool.update",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- ⏳ bash: ls -la");

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "ls -la",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- ✅ bash: ls -la");
  });

  it("truncates long tool labels later now that status text is iconized", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
      toolLabel: "123456789012345678901234567890",
    });

    expect(renderer.getCurrentProgress().markdown).toBe("- ⏳ bash: 123456789012345678901234…");
  });

  it("tracks status across the most recent event", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.update", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("running");

    renderer.takeProgressEvent({ type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("done");

    renderer.takeProgressEvent({ type: "assistant.tool.error", clientSessionId: "s1", toolName: "bash" });
    expect(renderer.getCurrentProgress().status).toBe("error");
  });

  it("keeps tool row order stable when a tool status updates", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "a",
      toolCallId: "call-a",
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "b",
      toolCallId: "call-b",
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "c",
      toolCallId: "call-c",
    });

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "b",
      toolCallId: "call-b",
    });

    expect(renderer.getCurrentProgress().markdown).toBe(["- ⏳ a", "- ✅ b", "- ⏳ c"].join("\n"));
  });

  it("collapses lines beyond the default threshold of 10", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("en-US") });

    for (let index = 1; index <= 12; index += 1) {
      renderer.takeProgressEvent({
        type: "assistant.tool.running",
        clientSessionId: "s1",
        toolName: `tool_${index}`,
      });
    }

    const progress = renderer.getCurrentProgress();
    expect(progress.collapsedCount).toBe(2);
    expect(progress.markdown).toBe(
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
  });

  it("honors a custom collapseThreshold", () => {
    const renderer = new ProgressRenderer({ collapseThreshold: 2, t: getTranslator("en-US") });

    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "a" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "b" });
    renderer.takeProgressEvent({ type: "assistant.tool.running", clientSessionId: "s1", toolName: "c" });

    const progress = renderer.getCurrentProgress();
    expect(progress.collapsedCount).toBe(1);
    expect(progress.markdown).toBe(["- Collapsed 1 earlier updates.", "- ⏳ b", "- ⏳ c"].join("\n"));
  });

  it("renders progress lines in Chinese when configured", () => {
    const renderer = new ProgressRenderer({ t: getTranslator("zh-CN") });
    const events: ProgressEvent[] = [
      { type: "assistant.tool.running", clientSessionId: "s1", toolName: "web_search" },
      { type: "assistant.tool.done", clientSessionId: "s1", toolName: "bash" },
      { type: "assistant.tool.error", clientSessionId: "s1", toolName: "read", toolLabel: "/tmp/demo.txt" },
      { type: "session.compacting", clientSessionId: "s1", text: "压缩上下文" },
    ];

    for (const event of events) {
      renderer.takeProgressEvent(event);
    }

    expect(renderer.getCurrentProgress().markdown).toBe(
      ["- ⏳ web_search", "- ✅ bash", "- ❌ read: /tmp/demo.txt", "- 正在压缩会话: 压缩上下文"].join(
        "\n",
      ),
    );
  });

  it("renders one randomized line from the pool in steps mode", () => {
    const renderer = new ProgressRenderer({
      mode: "steps",
      t: getTranslator("en-US"),
      random: () => 0,
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolLabel: "rm -rf /tmp/cache",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("loosening the thread pool");

    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "read",
      toolLabel: "/etc/hosts",
    });
    const progress = renderer.getCurrentProgress();
    // Pool membership, not a classification: the line has nothing to do with either tool.
    expect(progress.markdown).toBe("loosening the thread pool");
    expect(progress.collapsedCount).toBe(0);
  });

  it("never derives the line from the tool name, input or result", () => {
    const renderer = new ProgressRenderer({
      mode: "steps",
      t: getTranslator("en-US"),
      random: () => 0,
    });
    const inputs: Array<{ toolName: string; toolInput: Record<string, unknown> }> = [
      { toolName: "bash", toolInput: { command: "rm -rf /important" } },
      { toolName: "read", toolInput: { path: "/etc/passwd" } },
      { toolName: "mcp__jenkins__trigger_build", toolInput: { job: "OMOS" } },
      { toolName: "weird_tool", toolInput: { secret: "hunter2" } },
    ];

    for (const [index, entry] of inputs.entries()) {
      renderer.takeProgressEvent({
        type: "assistant.tool.running",
        clientSessionId: "s1",
        toolName: entry.toolName,
        toolInput: entry.toolInput,
        toolCallId: `call-${index}`,
      });
      const markdown = renderer.getCurrentProgress().markdown;
      expect(markdown).toBe("loosening the thread pool");
      expect(markdown).not.toContain("rm -rf");
      expect(markdown).not.toContain("/etc/passwd");
      expect(markdown).not.toContain("hunter2");
      expect(markdown).not.toContain("OMOS");
    }
  });

  it("collapses failures into one line in steps mode", () => {
    const renderer = new ProgressRenderer({
      mode: "steps",
      t: getTranslator("en-US"),
      random: () => 0,
    });
    renderer.takeProgressEvent({
      type: "assistant.tool.error",
      clientSessionId: "s1",
      toolName: "bash",
      text: "exit 1",
    });
    const progress = renderer.getCurrentProgress();
    expect(progress.markdown).toBe("That step misfired, continuing.");
    expect(progress.status).toBe("error");
  });

  it("renders step lines in Chinese", () => {
    const renderer = new ProgressRenderer({
      mode: "steps",
      t: getTranslator("zh-CN"),
      random: () => 0,
    });
    renderer.takeProgressEvent({ type: "session.compacting", clientSessionId: "s1" });
    expect(renderer.getCurrentProgress().markdown).toBe("正在给线程池放风");
  });

  it("draws differently across tool calls but keeps one line per call", () => {
    let next = 0;
    const renderer = new ProgressRenderer({
      mode: "steps",
      t: getTranslator("en-US"),
      random: () => (next === 0 ? 0 : 0.99),
    });

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    const first = renderer.getCurrentProgress().markdown;
    expect(first).toBe("loosening the thread pool");

    next = 1;
    renderer.takeProgressEvent({
      type: "assistant.tool.done",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-1",
    });
    expect(renderer.getCurrentProgress().markdown).toBe(first);

    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolCallId: "call-2",
    });
    // 0.99 lands on the last variant, whatever the pool currently holds.
    const pool = getTranslator("en-US")("progress.steps.pool").split("|");
    expect(renderer.getCurrentProgress().markdown).toBe(pool[pool.length - 1]);
  });

  it("keeps the per-tool log when mode is log", () => {
    const renderer = new ProgressRenderer({ mode: "log", t: getTranslator("en-US") });
    renderer.takeProgressEvent({
      type: "assistant.tool.running",
      clientSessionId: "s1",
      toolName: "bash",
      toolLabel: "npm test",
    });
    expect(renderer.getCurrentProgress().markdown).toBe("- ⏳ bash: npm test");
  });
});
