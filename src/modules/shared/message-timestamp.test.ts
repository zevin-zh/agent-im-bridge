import { describe, expect, it } from "vitest";
import {
  formatMessageTimestamp,
  isValidTimeZone,
  withMessageTimestampPrefix,
} from "./message-timestamp";

describe("message timestamp", () => {
  it("renders YYYY-MM-DD HH:mm:ss in an explicit time zone", () => {
    const date = new Date("2026-10-26T16:43:46Z");

    expect(formatMessageTimestamp(date, "Asia/Shanghai")).toBe("2026-10-27 00:43:46");
    expect(formatMessageTimestamp(date, "UTC")).toBe("2026-10-26 16:43:46");
    expect(formatMessageTimestamp(date, "America/New_York")).toBe("2026-10-26 12:43:46");
  });

  it("renders midnight as 00, never 24", () => {
    expect(formatMessageTimestamp(new Date("2026-01-01T00:00:00Z"), "UTC")).toBe(
      "2026-01-01 00:00:00",
    );
  });

  it("zero-pads every field", () => {
    expect(formatMessageTimestamp(new Date("2026-02-03T04:05:06Z"), "UTC")).toBe(
      "2026-02-03 04:05:06",
    );
  });

  it("falls back to the host time zone when none is configured", () => {
    const date = new Date("2026-10-26T16:43:46Z");
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(formatMessageTimestamp(date)).toBe(formatMessageTimestamp(date, hostZone));
  });

  it("prefixes the text with one bracketed line and keeps the text verbatim", () => {
    const text = "  hello\nworld  ";

    expect(withMessageTimestampPrefix(text, new Date("2026-10-26T16:43:46Z"), "UTC")).toBe(
      "[2026-10-26 16:43:46]\n  hello\nworld  ",
    );
  });

  it("recognizes real time zones and rejects made-up ones", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
