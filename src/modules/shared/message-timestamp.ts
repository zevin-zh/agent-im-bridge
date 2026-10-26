/**
 * Rendering helper for the optional inbound-message timestamp prefix
 * (`defaults.messageTimestamp`). The gateway prepends one bracket-timestamp
 * line to every chat-originated user message so the agent has wall-clock
 * context the IM platforms never hand over.
 *
 * The clock is assembled from `Intl.DateTimeFormat#formatToParts()` rather
 * than `Date#toLocaleString()`: the locale-string field order and the
 * locale-specific separator (a `/` in `en-US`, a `.` in `de-DE`) would have to
 * be rewritten per locale, whereas parts give one stable, sortable format
 * everywhere.
 */

/** The stable wall-clock format: `YYYY-MM-DD HH:mm:ss`, 24-hour, zero padded. */
const FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  // `hourCycle` (not `hour12: false`): the latter still renders midnight as
  // "24" on some ICU builds, `h23` always renders "00".
  hourCycle: "h23",
};

/**
 * Whether `timeZone` is an IANA zone this runtime can render. `Intl` accepts
 * both IANA names and UTC offsets ("+08:00"); anything else makes the
 * constructor throw a `RangeError`.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats `date` as `YYYY-MM-DD HH:mm:ss` in `timeZone` (an IANA zone name;
 * omitted means the host's own zone).
 */
export function formatMessageTimestamp(date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat(
    "en-US",
    timeZone === undefined ? FORMAT_OPTIONS : { ...FORMAT_OPTIONS, timeZone },
  );

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }

  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}`;
}

/**
 * The exact text handed to the agent adapter: one bracketed timestamp line
 * followed by the untouched user text.
 */
export function withMessageTimestampPrefix(text: string, date: Date, timeZone?: string): string {
  return `[${formatMessageTimestamp(date, timeZone)}]\n${text}`;
}
