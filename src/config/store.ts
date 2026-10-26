import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  AppConfig,
  ChannelConfig,
  ChannelCommonConfig,
  LocaleCode,
  MessageTimestampConfig,
} from "../types";
import { DEFAULT_LOCALE } from "../i18n";
import { isValidTimeZone } from "../modules/shared/message-timestamp";
import { DEFAULTS } from "./defaults";

const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-bridge");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

type RawChannelConfig = Omit<ChannelConfig, "common"> & {
  common?: Partial<ChannelCommonConfig>;
};

type RawAppConfig = {
  channels?: Record<string, RawChannelConfig>;
  defaults?: Partial<AppConfig["defaults"]>;
};

function normalizeLanguage(language: unknown): LocaleCode {
  return language === "en-US" || language === "zh-CN" ? language : DEFAULT_LOCALE;
}

/**
 * Normalizes `defaults.allowedWorkingDirectoryRoots` from raw config input.
 *
 * - `undefined` stays `undefined` (permissive, legacy configs keep working)
 * - a non-array value is a hard config error
 * - entries must be strings; non-string entries are a hard config error
 * - entries are trimmed; empty/whitespace entries are dropped; duplicates are
 *   removed (first occurrence wins, order preserved)
 * - an empty array (or one that normalizes to empty) means permissive
 */
function normalizeAllowedWorkingDirectoryRoots(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("defaults.allowedWorkingDirectoryRoots must be an array of non-empty strings");
  }

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw new Error("defaults.allowedWorkingDirectoryRoots must contain only non-empty strings");
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    roots.push(trimmed);
  }
  return roots;
}

/**
 * Normalizes `defaults.messageTimestamp` from raw config input.
 *
 * - `undefined` and `false` stay `undefined` (the feature is opt-in, and a
 *   legacy config must not gain a new field on save)
 * - `true` enables the prefix with the host time zone
 * - an object may only carry `timeZone`; an unknown key or a non-string
 *   value is a hard config error, and so is a zone `Intl` cannot resolve
 *   (a typo must not silently fall back to the host zone and mislabel times)
 */
function normalizeMessageTimestamp(raw: unknown): MessageTimestampConfig | undefined {
  if (raw === undefined || raw === false) return undefined;
  if (raw === true) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("defaults.messageTimestamp must be a boolean or an object");
  }

  const { timeZone, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) {
    throw new Error("defaults.messageTimestamp supports only the timeZone option");
  }
  if (timeZone === undefined) return {};
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    throw new Error("defaults.messageTimestamp.timeZone must be a non-empty string");
  }
  const trimmed = timeZone.trim();
  if (!isValidTimeZone(trimmed)) {
    throw new Error(`defaults.messageTimestamp.timeZone is not a valid time zone: ${trimmed}`);
  }
  return { timeZone: trimmed };
}

/**
 * Normalizes `defaults.streaming` from raw config input.
 *
 * - `undefined` stays `undefined` (streaming is on by default, and a legacy
 *   config must not gain a new field on save)
 * - a boolean is taken as-is
 * - anything else is a hard config error (a typo such as `"false"` must not
 *   silently flip the behavior in either direction)
 */
function normalizeStreaming(raw: unknown): boolean | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === "boolean") return raw;
  throw new Error("defaults.streaming must be a boolean");
}

function normalizeChannelConfig(channel: RawChannelConfig): ChannelConfig {
  if (!channel.client || !channel.agent) {
    throw new Error("Invalid channel config shape");
  }
  return {
    common: {
      language: normalizeLanguage(channel.common?.language),
    },
    client: channel.client,
    agent: channel.agent,
  };
}

function mergeDefaults(config: RawAppConfig = {}): AppConfig {
  const channels = Object.fromEntries(
    Object.entries(config.channels ?? {}).map(([name, channel]) => [name, normalizeChannelConfig(channel)]),
  );

  const allowedWorkingDirectoryRoots = normalizeAllowedWorkingDirectoryRoots(
    config.defaults?.allowedWorkingDirectoryRoots,
  );
  const messageTimestamp = normalizeMessageTimestamp(config.defaults?.messageTimestamp);
  const streaming = normalizeStreaming(config.defaults?.streaming);

  return {
    channels,
    defaults: {
      agentIdleTimeoutMs: config.defaults?.agentIdleTimeoutMs ?? DEFAULTS.agentIdleTimeoutMs,
      ...(allowedWorkingDirectoryRoots !== undefined ? { allowedWorkingDirectoryRoots } : {}),
      ...(messageTimestamp !== undefined ? { messageTimestamp } : {}),
      ...(streaming !== undefined ? { streaming } : {}),
    },
  };
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureConfigDir();
  try {
    const raw = await readFile(CONFIG_PATH, "utf8");
    return mergeDefaults(JSON.parse(raw) as RawAppConfig);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return mergeDefaults();
    }
    throw error;
  }
}

export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await ensureConfigDir();
  const merged = mergeDefaults(config);
  await writeFile(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}
