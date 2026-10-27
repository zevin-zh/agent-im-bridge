import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readFile = vi.fn();
const writeFile = vi.fn();
const mkdir = vi.fn(async () => {});

vi.mock("node:fs/promises", () => ({
  readFile,
  writeFile,
  mkdir,
}));

vi.mock("node:os", () => ({
  default: {
    homedir: () => "/tmp/agent-bridge-home",
  },
}));

describe("config store", () => {
  beforeEach(() => {
    vi.resetModules();
    readFile.mockReset();
    writeFile.mockReset();
    mkdir.mockClear();
  });

  it("fills in en-US as the default channel language for legacy configs", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        channels: {
          legacy: {
            client: { type: "wecom", config: { botId: "bot", secret: "sec" } },
            agent: { type: "pi-coding-agent", config: {} },
          },
        },
      }),
    );

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.channels.legacy?.common).toEqual({ language: "en-US" });
  });

  it("keeps legacy configs working without allowedWorkingDirectoryRoots", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({}));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.allowedWorkingDirectoryRoots).toBeUndefined();
    expect(config.defaults.agentIdleTimeoutMs).toBe(24 * 60 * 60 * 1000);
  });

  it("trims, drops empty entries, and dedupes allowedWorkingDirectoryRoots", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        defaults: {
          allowedWorkingDirectoryRoots: [
            "  /srv/projects  ",
            "",
            "   ",
            "/srv/projects",
            "/home/me/work",
          ],
        },
      }),
    );

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.allowedWorkingDirectoryRoots).toEqual([
      "/srv/projects",
      "/home/me/work",
    ]);
  });

  it("accepts an empty array as permissive", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        defaults: {
          allowedWorkingDirectoryRoots: [],
        },
      }),
    );

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.allowedWorkingDirectoryRoots).toEqual([]);
  });

  it("rejects a non-array allowedWorkingDirectoryRoots with a clear error", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        defaults: {
          allowedWorkingDirectoryRoots: "/srv/projects",
        },
      }),
    );

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.allowedWorkingDirectoryRoots must be an array of non-empty strings",
    );
  });

  it("rejects non-string entries in allowedWorkingDirectoryRoots", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({
        defaults: {
          allowedWorkingDirectoryRoots: ["/srv/projects", 42],
        },
      }),
    );

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.allowedWorkingDirectoryRoots must contain only non-empty strings",
    );
  });

  it("keeps legacy configs working without messageTimestamp", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { agentIdleTimeoutMs: 5000 } }));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.messageTimestamp).toBeUndefined();
    expect(config.defaults).toEqual({ agentIdleTimeoutMs: 5000 });
  });

  it("treats messageTimestamp false as off", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { messageTimestamp: false } }));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.messageTimestamp).toBeUndefined();
  });

  it("normalizes messageTimestamp true to an empty option object", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { messageTimestamp: true } }));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.messageTimestamp).toEqual({});
  });

  it("trims a configured messageTimestamp time zone", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({ defaults: { messageTimestamp: { timeZone: "  Asia/Shanghai  " } } }),
    );

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.messageTimestamp).toEqual({ timeZone: "Asia/Shanghai" });
  });

  it("rejects a non-object, non-boolean messageTimestamp", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { messageTimestamp: "yes" } }));

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.messageTimestamp must be a boolean or an object",
    );
  });

  it("rejects an unknown messageTimestamp option", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({ defaults: { messageTimestamp: { format: "iso" } } }),
    );

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.messageTimestamp supports only the timeZone option",
    );
  });

  it("rejects a non-string messageTimestamp time zone", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({ defaults: { messageTimestamp: { timeZone: 8 } } }),
    );

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.messageTimestamp.timeZone must be a non-empty string",
    );
  });

  it("rejects a messageTimestamp time zone Intl cannot resolve", async () => {
    readFile.mockResolvedValueOnce(
      JSON.stringify({ defaults: { messageTimestamp: { timeZone: "Mars/Olympus_Mons" } } }),
    );

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow(
      "defaults.messageTimestamp.timeZone is not a valid time zone: Mars/Olympus_Mons",
    );
  });

  it("persists a configured messageTimestamp on save", async () => {
    const { saveConfig } = await import("./store");

    await saveConfig({
      defaults: { agentIdleTimeoutMs: 5000, messageTimestamp: { timeZone: "Asia/Shanghai" } },
    });

    const [, payload] = writeFile.mock.calls[0]!;
    expect(JSON.parse(String(payload))).toEqual({
      channels: {},
      defaults: { agentIdleTimeoutMs: 5000, messageTimestamp: { timeZone: "Asia/Shanghai" } },
    });
  });

  it("keeps legacy configs working without a streaming flag", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { agentIdleTimeoutMs: 5000 } }));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.streaming).toBeUndefined();
    expect(config.defaults).toEqual({ agentIdleTimeoutMs: 5000 });
  });

  it("keeps an explicit streaming flag from the config file", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { streaming: false } }));

    const { loadConfig } = await import("./store");
    const config = await loadConfig();

    expect(config.defaults.streaming).toBe(false);
  });

  it("rejects a non-boolean streaming flag", async () => {
    readFile.mockResolvedValueOnce(JSON.stringify({ defaults: { streaming: "yes" } }));

    const { loadConfig } = await import("./store");
    await expect(loadConfig()).rejects.toThrow("defaults.streaming must be a boolean");
  });

  it("persists an explicit streaming flag on save", async () => {
    const { saveConfig } = await import("./store");

    await saveConfig({ defaults: { agentIdleTimeoutMs: 5000, streaming: true } });

    const [, payload] = writeFile.mock.calls[0]!;
    expect(JSON.parse(String(payload))).toEqual({
      channels: {},
      defaults: { agentIdleTimeoutMs: 5000, streaming: true },
    });
  });

  it("persists normalized allowedWorkingDirectoryRoots on save", async () => {
    const { saveConfig } = await import("./store");

    await saveConfig({
      defaults: {
        agentIdleTimeoutMs: 5000,
        allowedWorkingDirectoryRoots: ["/a", "/b"],
      },
    });

    expect(writeFile).toHaveBeenCalledTimes(1);
    const [filePath, payload, encoding] = writeFile.mock.calls[0]!;
    expect(filePath).toBe(
      path.join("/tmp/agent-bridge-home", ".config", "agent-bridge", "config.json"),
    );
    expect(encoding).toBe("utf8");
    expect(JSON.parse(String(payload))).toEqual({
      channels: {},
      defaults: {
        agentIdleTimeoutMs: 5000,
        allowedWorkingDirectoryRoots: ["/a", "/b"],
      },
    });
  });
});
