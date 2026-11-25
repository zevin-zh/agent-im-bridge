# agent-bridge

[![npm version](https://img.shields.io/npm/v/%40hopgoldy%2Fagent-bridge?style=flat-square&logo=npm)](https://www.npmjs.com/package/@hopgoldy/agent-bridge)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](#license)

`agent-bridge` connects an IM channel (WeCom, Weixin, Feishu) to a local coding agent (pi, OpenCode) through a dual-adapter architecture: one adapter speaks to the chat platform, one drives the agent process, and the core only forwards messages between them. No harness layer, no extra tools, no extra skills.

This fork keeps that architecture and adds a deeper WeCom experience: a single in-place reply bubble, group speaker awareness, quoted-message context, attachment housekeeping and runtime thinking-level control.

## Supported platforms

Client side:

| Platform      | Image/file in | Image/file out | Emoji | In-place progress |
| ------------- | ------------- | -------------- | ----- | ----------------- |
| Feishu / Lark | yes           | yes            | yes   | yes               |
| WeCom         | yes           | yes            | -     | yes               |
| Weixin        | yes           | yes            | -     | -                 |

Agent side:

| Agent           | New session | Stop | Compact | Model switch | Thinking level |
| --------------- | ----------- | ---- | ------- | ------------ | -------------- |
| PI Coding Agent | yes         | yes  | yes     | yes          | yes            |
| OpenCode        | yes         | yes  | yes     | yes          | -              |

## Quick start

```bash
npm install -g @hopgoldy/agent-bridge
agent-bridge add          # interactive channel setup
agent-bridge start wecom  # start the channel you just created
agent-bridge ls           # list configured channels
```

`agent-bridge add` asks for a channel name, a client type and its config, then an agent type and its config. Everything lands in `~/.config/agent-bridge/config.json`.

## CLI

Channels:

- `agent-bridge add`
- `agent-bridge ls`
- `agent-bridge remove <channel-name>`
- `agent-bridge start <channel-name>`

Scheduled tasks:

- `agent-bridge schedule add`
- `agent-bridge schedule list`
- `agent-bridge schedule run <task-name>`
- `agent-bridge schedule enable <task-name>` / `disable <task-name>` / `remove <task-name>`
- `agent-bridge schedule history [task-name]`

Queues:

- `agent-bridge queue add`
- `agent-bridge queue insert <queue-name> --prompt "..." [--directory <path>] [--model <model>] [--timeout 10m] [--silence 30m]`
- `agent-bridge queue list`
- `agent-bridge queue enable <queue-name>` / `disable <queue-name>` / `remove <queue-name>`
- `agent-bridge queue history <queue-name>`
- `agent-bridge queue retry <queue-name> <task-id>`

## Configuration

```json
{
  "channels": {
    "wecom": {
      "common": { "language": "zh-CN" },
      "client": {
        "type": "wecom",
        "config": {
          "botId": "…",
          "secret": "…",
          "requireMentionInGroup": true,
          "botName": "瓦达西(Vaddasi)"
        }
      },
      "agent": {
        "type": "pi-coding-agent",
        "config": {
          "bin": "/usr/bin/pi",
          "sessionDir": "/root/.pi/agent/sessions/--root-wecom--",
          "model": "company/minimax-m2.7",
          "extraArgs": ["--thinking", "high"]
        }
      }
    }
  },
  "defaults": {
    "agentIdleTimeoutMs": 1800000,
    "messageTimestamp": { "timeZone": "Asia/Shanghai" }
  }
}
```

### Channel common

| Key           | Type                | Meaning                                       |
| ------------- | ------------------- | --------------------------------------------- |
| `channelName` | string              | Auto-filled from the map key                  |
| `language`    | `"zh-CN" \| "en-US"` | Language of progress lines and command replies |

### WeCom client config

| Key                    | Type                              | Default                              | Meaning                                                                                   |
| ---------------------- | --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `botId`                | string                            | -                                    | Smart-robot id                                                                            |
| `secret`               | string                            | -                                    | Smart-robot secret                                                                        |
| `websocketUrl`         | string                            | `wss://openws.work.weixin.qq.com`    | Custom endpoint                                                                            |
| `requireMentionInGroup`| boolean                           | `true`                               | Only answer group messages that @ the bot                                                 |
| `botName`              | string                            | -                                    | Bot display name used to verify group mentions; unset means any leading `@` counts         |
| `userLabels`           | `Record<string, string>`          | -                                    | Maps WeCom user ids to readable names for the speaker line                                |
| `mentionSender`        | `"markdown" \| "text" \| "none"`  | `"markdown"`                         | How a group reply points at the asker; see the caveat below                                |
| `replyProgress`        | `"steps" \| "log"`                | `"steps"`                            | Progress style: one randomized step line, or the per-tool log                              |
| `streamAnswer`         | boolean                           | `false`                              | `true` streams answer text into the bubble; `false` lands it in one closing frame           |
| `showStepResult`       | boolean                           | `true`                               | Show a short note after each completed step                                                |
| `stepResultDetail`     | `"status" \| "raw"`               | `"status"`                           | `status` shows a phrase, `raw` shows a truncated excerpt of the tool result                |
| `stepHeartbeatMs`      | number                            | `15000`                              | Refresh cadence of a motionless bubble; `0` disables the heartbeat                         |

### PI agent config

| Key          | Type       | Default | Meaning                                                     |
| ------------ | ---------- | ------- | ----------------------------------------------------------- |
| `bin`        | string     | `"pi"`  | pi executable                                               |
| `sessionDir` | string     | -       | Where pi stores session files                               |
| `model`      | string     | -       | `provider/modelId`, optionally with `:<thinking>` shorthand |
| `extraArgs`  | `string[]` | `[]`    | Extra pi flags, for example `["--thinking", "high"]`        |

### Defaults

| Key                            | Type                              | Meaning                                                                 |
| ------------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| `agentIdleTimeoutMs`           | number                            | Idle time before a session's agent process is released                  |
| `allowedWorkingDirectoryRoots` | `string[]`                        | Allowlist for `/new <path>`; unset means permissive                      |
| `messageTimestamp`             | `{timeZone} \| true \| false`     | Prefix inbound text with its arrival time                                |
| `streaming`                    | boolean                           | `false` forces one completed message per turn and drops delta frames     |

## WeCom channel behaviour

### One run, one bubble

Each inbound message opens a single streamed reply bubble. A follow-up that arrives while the agent is still working steers the active run instead of opening a second bubble, and the bubble says so. The bubble is closed on `agent_settled`, never on `agent_end`, because pi may still retry, compact or accept steering after `agent_end`.

### Step line

While the agent works the bubble shows one line, drawn from a pool of 70 programmer-flavored phrases and pinned for the duration of that tool call, so `running` / `update` / `done` events do not reshuffle it. Tool names, command lines, arguments and results never reach the chat. With `replyProgress: "log"` the older per-tool lines come back.

When a step finishes, `showStepResult` adds one short status note under the line. `stepResultDetail: "raw"` swaps that note for a truncated excerpt of the tool result.

A frame whose body has not changed is skipped entirely: those frames would only repaint the same text.

### Heartbeat

A long step refreshes the line with a rotating dot every `stepHeartbeatMs` (15s by default). Every stream frame rewrites the whole body and the client repaints on each one, so the cadence trades "looks alive" against visible flicker. `0` disables it.

### Answer in the closing frame

Answer text is withheld while the agent works. The closing frame carries the whole answer and overwrites every step line, so the bubble ends up holding the result and nothing else. Bodies over the 16 KB budget — kept under WeCom's 20 KB per-frame limit — hold the head in the bubble and deliver the remainder as follow-up messages.

If the server already closed the stream (its 10 minute cap), the bridge reopens a fresh bubble for the same message and puts the answer there instead of falling back to a second chat message.

### Groups: mentions and speakers

Set `botName` to the bot's display name. A mention then only counts when it names that bot, and a parenthesized alias is ignored, so both `@瓦达西(Vaddasi)` and `@瓦达西` match. Without `botName`, any leading `@` counts, which is the pre-existing behaviour. Every leading `@name` is stripped from the prompt either way.

Group prompts carry a speaker line so the agent knows who is asking:

```
[speaker: u-2]
[quoted: the previous error log]
这个怎么办
```

WeCom never sends a display name, so `userLabels` maps ids to readable names; unmapped ids pass through. Direct messages get no speaker line.

### Quoted messages

When a user quotes another message before asking, WeCom ships it as `body.quote`. Its text is flattened onto one line and prefixed as `[quoted: ...]` so the agent can answer about the cited message. Image, file and voice quotes are labelled (`[image]`, `[file]`, `[voice]`) rather than downloaded.

### Pointing at the asker

`mentionSender` prepends a mention to a group reply: `markdown` uses `<@userid>`, `text` uses a literal `@label`, `none` disables it.

Caveat: WeCom's `<@userid>` syntax is documented for bot text/markdown messages, and smart-robot **stream** frames do not resolve it — the string is shown verbatim. If you see raw `<@…>` in a reply, set `mentionSender` to `text` or `none`.

### Attachments

Images and files sent to the bot are downloaded into the OS temp directory (`<tmp>/agent-bridge-wecom-media`), capped at 20 MB per file, and referenced in the prompt by path. Files older than 7 days are pruned on connect and at most once an hour afterwards.

### Welcome reply

WeCom sends an `enter_chat` event every time someone opens the bot conversation. The client answers with a random line from a fixed pool (`WECOM_WELCOME_REPLIES` in `src/modules/client/wecom/adapter/wecom-client.ts`), which keeps the bot from repeating one canned greeting all day. Editing the pool means editing that array and rebuilding.

### Bounded state

Reply and stream contexts are kept for the most recent 500 message ids, and processed message ids for the most recent 500 callbacks. Anything older is only needed by a retry that will never come.

## Slash commands

Handled locally, without touching the agent:

| Command | Meaning |
| ------- | ------- |
| `/help` `/h` | Show the command list |
| `/think` | Invalid or missing level: answer with usage only, no bubble, no session |
| `/schedule-run <name>` | Fire a scheduled task once, delivering to its bound chat |
| `/schedule-here <name>` | Bind this chat as that task's result destination |
| `/queue-here <name>` | Bind this chat as a queue's result destination |

Handled by the core, requires an existing session:

| Command | Meaning |
| ------- | ------- |
| `/status` `/st` | Session id, model, thinking level, context usage |
| `/model` `/m` | List models, or `/model provider/modelId` to switch |
| `/think <level>` | Switch the thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `/compact` `/c` | Compact the session context |
| `/stop` `/s` | Abort the current turn |

Session lifecycle:

| Command | Meaning |
| ------- | ------- |
| `/new [path]` `/n [path]` | Start a new session, optionally in a given directory |
| `/resume <id>` `/r <id>` | Adopt an existing provider session |

`/status`, `/model`, `/think <level>`, `/compact` and `/stop` need a session to exist; in a fresh chat they answer that switching is unavailable rather than starting an agent process.

## Thinking level

pi accepts `--thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) and the `provider/model:level` shorthand. Set the startup level through `agent.config.extraArgs`, and switch it on a live session with `/think`. Runtime switches do not survive a restart.

## Logging

The process logs at `info` by default. Per-event chatter — every SDK frame, every inbound message, every forwarded tool event — is logged at `debug`. Set `LOG_LEVEL=debug` in the service environment when that trace is needed.

On a systemd host, rotate `/root/.config/agent-bridge/*.log` weekly or at 20 MB, keeping four compressed rotations. `copytruncate` is required because systemd holds the log open in append mode.

## Development

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

`npm run build` bundles `src/` into `dist/agent-bridge.js` with tsup. The test suite runs on vitest.

Layout:

- `src/core/` — gateway core: session lifecycle, command routing, event fan-out
- `src/modules/client/` — IM adapters (`wecom`, `weixin`, `feishu`) and shared progress rendering
- `src/modules/agent/` — agent adapters (`pi-coding-agent`, `opencode`)
- `src/modules/queue/`, `src/modules/schedule/` — queues and scheduled tasks
- `src/i18n/` — zh-CN / en-US strings for progress lines and command replies

## License

MIT
