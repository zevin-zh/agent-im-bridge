# agent-bridge

[![npm version](https://img.shields.io/npm/v/%40hopgoldy%2Fagent-bridge?style=flat-square&logo=npm)](https://www.npmjs.com/package/@hopgoldy/agent-bridge)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/%40hopgoldy%2Fagent-bridge?style=flat-square)](https://www.npmjs.com/package/@hopgoldy/agent-bridge)
[![test status](https://img.shields.io/github/actions/workflow/status/HoPGoldy/agent-bridge/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/HoPGoldy/agent-bridge/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](#license)

`agent-bridge` connects IM channel (feishu, weixin, wecom...) to local coding agent (pi, codex, opencode...) using a dual-adapter architecture.

The design stays intentionally simple and compact: no harness layer, no extra tools, no extra skills, just forwarding messages from IM to the local agent.

## Current support

Client side:

| Platform      | Image/file in | Image/file out | Emoji | Dynamic progress |
| ------------- | ------------- | -------------- | ----- | ---------------- |
| Feishu / Lark | ✅            | ✅             | ✅    | ✅               |
| WeCom         | ✅            | ✅             | —     | ✅               |
| Weixin        | ✅            | ✅             | —     | —                |

- **Emoji** = platform-native emoji / reaction capability currently used by the bridge.
- **Dynamic progress** = progress shown before the final answer arrives.

Agent side:

| Agent           | New | Stop | Compact | Model switching | Setup guide                        |
| --------------- | --- | ---- | ------- | --------------- | ---------------------------------- |
| PI Coding Agent | ✅  | ✅   | ✅      | ✅              | [Guide](./docs/pi-coding-agent.md) |
| OpenCode        | ✅  | ✅   | ✅      | ✅              | [Guide](./docs/opencode.md)        |

> The current built-in support is intentionally small, but the architecture is designed for straightforward horizontal extension. The project will primarily maintain the integrations used in practice today, and contributions for additional client or agent adapters are welcome through forks and PRs.

## Quick Start

Install the CLI:

```bash
npm install -g @hopgoldy/agent-bridge
```

The CLI currently provides these commands:

- `agent-bridge add`
- `agent-bridge ls`
- `agent-bridge remove <channel-name>`
- `agent-bridge start <channel-name>`
- `agent-bridge queue add`
- `agent-bridge queue insert <queue-name> --prompt "..." [--directory <path>]`
- `agent-bridge queue list`
- `agent-bridge schedule history [task-name]`
- `agent-bridge queue history <queue-name>`

Create a channel interactively:

```bash
agent-bridge add
```

The prompt flow currently asks for:

- channel name
- select client module type
- set client config...
- select agent module type
- set agent config...

Start the configured channel:

```bash
agent-bridge start <channel-name>
```

List configured channels:

```bash
agent-bridge ls
```

Remove a configured channel:

```bash
agent-bridge remove <channel-name>
```

Config file: `~/.config/agent-bridge/config.json`

Architecture overview: [`docs/architecture-design.md`](./docs/architecture-design.md)

Command usage across IM adapters: [`docs/command-system.md`](./docs/command-system.md)

You can also **adopt an existing provider session** (for example one from the pi or OpenCode TUI) into a chat with `/resume <provider-session-id>` (`/r`): the agent context and working directory are fully restored and later messages continue that session. See [`docs/command-system.md`](./docs/command-system.md).

Scheduled tasks (cron-style agent sessions with file-based prompts): [`docs/scheduled-tasks.md`](./docs/scheduled-tasks.md)

Event queues (FIFO agent task queues with file-based prompts, worker concurrency and chat-bound result delivery): [`docs/event-queue.md`](./docs/event-queue.md)

Event queues let you run a stream of agent prompts through the same pipeline as scheduled tasks: a queue definition (`queues/<name>.md`) carries a worker count, an optional model and a shared-context body appended to every task; tasks are inserted with `agent-bridge queue insert` and consumed FIFO by the owning channel's controller, which delivers each result (or failure/timeout notice) to the chat bound with `/queue-here`. Like scheduled tasks, queue runs are fully isolated from the target chat's own session. Both scheduled tasks and event queues use the same completion protocol: the run ends when the agent appends the `BRIDGE_TASK_STATUS_DONE` marker as the last line of its final message, at which point the full accumulated transcript is delivered once; a silence probe asks an inactive run whether it is finished, and the wall-clock `timeout` remains the hard cap.

## Start a session in a specific directory

From any IM chat, `/new <path>` starts the next agent session in that directory instead of the bridge's working directory:

```text
/new ~/project-learn/demo
```

A directory given once is remembered per chat (persisted in the channel's client session store): a later bare `/new` reuses it, and only falls back to the bridge's working directory when nothing was ever chosen. Paths are validated locally before a session is created — invalid ones are rejected immediately and never remembered — see [`docs/command-system.md`](./docs/command-system.md) for details.

If the bot is not strictly private, restrict the directories users may start sessions in via `defaults.allowedWorkingDirectoryRoots` in `~/.config/agent-bridge/config.json`:

```json
{
  "defaults": {
    "allowedWorkingDirectoryRoots": ["/Users/wesley/project-learn"]
  }
}
```

When configured, user-originated `/new <path>` targets (including remembered defaults) must resolve inside one of the roots. The client-side cwd fallback for a bare `/new` and the channel-level agent configuration are trusted and never checked.

The bridge also releases agent sessions that are idle: a session whose last observable activity is older than `defaults.agentIdleTimeoutMs` (default `24h`) is stopped and released. The idle timer is pure inactivity — it tracks the last run event and reschedules whenever one arrives; there is no busy check. The agent adapters defend themselves internally (an `abort()` when there is no active turn is a no-op), and `/model` performs no busy gating.

## Prefix incoming messages with a timestamp

Some agents benefit from seeing when a message was sent. Set `defaults.messageTimestamp` to have the bridge prepend one `[YYYY-MM-DD HH:mm:ss]` line to every user message that reaches the agent:

```json
{
  "defaults": {
    "messageTimestamp": true
  }
}
```

The clock is read when the message arrives, so a long-lived channel never stamps stale times. Add `timeZone` (any IANA name) to pin the zone — without it the host's local zone is used:

```json
{
  "defaults": {
    "messageTimestamp": { "timeZone": "Asia/Shanghai" }
  }
}
```

Only text typed by a person in the IM app is stamped. Prompts injected by scheduled tasks and event queues are left untouched, because their bodies (including the `BRIDGE_TASK_STATUS_DONE` marker) are part of the completion protocol. The setting is off by default; `false` is the same as omitting it. Note that pi already records a millisecond timestamp on every message, so this option exists to make the time visible to the model in the message body itself, not to add information the agent adapter lacks.

## Stream replies in place

WeCom is the first client that renders an answer while the agent is still writing. Instead of one message per assistant turn (which reads as a burst of separate bubbles), the bridge keeps rewriting the single reply bubble it already opened for that message, then closes it once the run is settled.

This is on by default for clients that support it. Turn it off with:

```json
{
  "defaults": {
    "streaming": false
  }
}
```

How it works, and what it costs:

- The pi adapter listens for `message_update` / `text_delta` frames, accumulates them per run and emits at most one `assistant.delta` every 600 ms. Each frame carries the whole run text, never a patch, because WeCom overwrites `stream.content` per frame rather than appending.
- The bubble is closed on `agent_settled`, not `agent_end`. Pi may still retry, compact, or accept steering after `agent_end`; `agent_settled` is the only authoritative "no more output" signal.
- Tool activity lines stay in the same bubble above the answer, so progress and text never fight for two places.
- WeCom caps one streamed reply at 20480 bytes and 10 minutes; the bridge truncates long bodies (head + tail) instead of failing, and a finish frame on an already-closed stream only logs a warning.
- `MEDIA:` directives are stripped from streamed frames — a half-received marker would otherwise flash in the bubble — and the real attachments are sent after the run completes.
- Clients without streaming support (WeChat personal accounts) ignore these frames entirely; the gateway drops them before they reach the adapter, so nothing changes for them.

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

## Q&A

### Why not implement this directly as a `pi-feishu`, `pi-wechat`, or similar plugin?

Because plugin-style integrations for Pi or similar local agents do not provide enough control over session lifecycle, channel behavior, and local runtime isolation.

In practice, this shows up in a few ways:

- It is hard to implement a real `/new` that cleanly resets the remote conversation while keeping channel-side routing predictable.
- Connecting the same local agent cleanly to multiple channels is much harder when each integration is embedded as a plugin inside the agent runtime.
- Different channels have very different behavior, and existing integrations are often maintained independently without a shared contract.
- The local development and runtime experience becomes much more invasive: starting Pi for normal local work can also start multiple channel-facing plugins and inject extra tools that are unrelated to the task at hand.

`agent-bridge` takes the opposite approach: keep the local agent runtime focused, keep channel integration outside the agent process, and make session routing explicit at the bridge layer.

## License

MIT.
