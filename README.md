# agent-bridge

[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](#license)

`agent-bridge` 用双适配器架构把 IM 通道和企业微信、微信、飞书接到本地编码 agent 和 pi、OpenCode 之间。一个适配器对接聊天平台，一个驱动 agent 进程，中间的核心只负责转发消息。没有 harness 层，没有额外工具，没有额外技能。

这个 fork 保留原有架构，并在 WeCom 上做得更深：单条气泡原地刷新、群聊发言人识别、引用消息上下文、附件清理、运行时调整思考强度。

> 只从源码构建安装。npm 上的 `@hopgoldy/agent-bridge` 是上游原版，不含本仓库的 WeCom 改动。

## 支持的平台

客户端：

| 平台          | 图片/文件接收 | 图片/文件发送 | Emoji | 原地进度 |
| ------------- | ------------- | ------------- | ----- | -------- |
| 飞书 / Lark   | 支持          | 支持          | 支持  | 支持     |
| 企业微信      | 支持          | 支持          | -     | 支持     |
| 微信          | 支持          | 支持          | -     | -        |

Agent：

| Agent           | 新会话 | 停止 | 压缩 | 切换模型 | 思考强度 |
| --------------- | ------ | ---- | ---- | -------- | -------- |
| PI Coding Agent | 支持   | 支持 | 支持 | 支持     | 支持     |
| OpenCode        | 支持   | 支持 | 支持 | 支持     | -        |

## 安装

前置条件：Node.js 22 以上，以及要对接的 agent 可执行文件，例如 `pi` 在 PATH 里。

```bash
git clone https://github.com/zevin-zh/agent-im-bridge.git
cd agent-im-bridge
npm install
npm run build
npm install -g .
```

`npm install -g .` 把本地构建产物装成全局命令。不想污染全局环境的话，直接用 `node dist/agent-bridge.js <子命令>`，下面所有 `agent-bridge` 命令都等价替换。

升级：

```bash
git pull
npm install
npm run build
npm install -g .
```

## 快速开始

```bash
agent-bridge add          # 交互式创建通道
agent-bridge start wecom  # 启动刚创建的通道
agent-bridge ls           # 列出已配置的通道
```

`agent-bridge add` 会依次询问通道名、客户端类型及其配置、agent 类型及其配置，结果写入 `~/.config/agent-bridge/config.json`。进程是前台运行的，常驻需要 systemd、pm2 或容器重启策略。

## 命令行

通道：

- `agent-bridge add`
- `agent-bridge ls`
- `agent-bridge remove <channel-name>`
- `agent-bridge start <channel-name>`

定时任务：

- `agent-bridge schedule add`
- `agent-bridge schedule list`
- `agent-bridge schedule run <task-name>`
- `agent-bridge schedule enable <task-name>` / `disable <task-name>` / `remove <task-name>`
- `agent-bridge schedule history [task-name]`

队列：

- `agent-bridge queue add`
- `agent-bridge queue insert <queue-name> --prompt "..." [--directory <path>] [--model <model>] [--timeout 10m] [--silence 30m]`
- `agent-bridge queue list`
- `agent-bridge queue enable <queue-name>` / `disable <queue-name>` / `remove <queue-name>`
- `agent-bridge queue history <queue-name>`
- `agent-bridge queue retry <queue-name> <task-id>`

## 配置

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

### 通道公共配置

| 字段          | 类型                 | 说明                           |
| ------------- | -------------------- | ------------------------------ |
| `channelName` | string               | 由配置的键名自动填入           |
| `language`    | `"zh-CN" \| "en-US"` | 进度文案和命令回复所使用的语言 |

### WeCom 客户端配置

| 字段                     | 类型                             | 默认值                            | 说明                                                                     |
| ------------------------ | -------------------------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `botId`                  | string                           | -                                 | 智能机器人 id                                                            |
| `secret`                 | string                           | -                                 | 智能机器人 secret                                                        |
| `websocketUrl`           | string                           | `wss://openws.work.weixin.qq.com` | 自定义接入地址                                                           |
| `requireMentionInGroup`  | boolean                          | `true`                            | 群聊里只响应 @ 机器人的消息                                              |
| `botName`                | string                           | -                                 | 用来校验群聊 @ 的机器人显示名，不配则任意前导 @ 都算                     |
| `userLabels`             | `Record<string, string>`         | -                                 | 把企业微信 user id 映射成可读名字，用于发言人标识                        |
| `mentionSender`          | `"none" \| "text" \| "markdown"` | `"none"`                          | 群聊回复如何指向提问人；`markdown` 在智能机器人流式帧上无效，见下文       |
| `replyProgress`          | `"steps" \| "log"`               | `"steps"`                         | 进度样式：单行随机文案，或逐个工具调用日志                               |
| `streamAnswer`           | boolean                          | `false`                           | `true` 让答案边生成边写入气泡，`false` 只在收尾帧一次性落地               |
| `showStepResult`         | boolean                          | `true`                            | 每步完成后是否追加一句状态提示                                           |
| `stepResultDetail`       | `"status" \| "raw"`              | `"status"`                        | `status` 显示一句短语，`raw` 显示截断后的工具结果                        |
| `stepHeartbeatMs`        | number                           | `15000`                           | 气泡静止时的刷新间隔，`0` 关闭心跳                                       |

### PI agent 配置

| 字段         | 类型       | 默认值 | 说明                                                      |
| ------------ | ---------- | ------ | --------------------------------------------------------- |
| `bin`        | string     | `"pi"` | pi 可执行文件                                             |
| `sessionDir` | string     | -      | pi 存放会话文件的目录                                     |
| `model`      | string     | -      | `provider/modelId`，也可写成 `provider/modelId:high` 简写 |
| `extraArgs`  | `string[]` | `[]`   | 追加给 pi 的启动参数，例如 `["--thinking", "high"]`       |

### defaults

| 字段                           | 类型                          | 说明                                               |
| ------------------------------ | ----------------------------- | -------------------------------------------------- |
| `agentIdleTimeoutMs`           | number                        | 会话空闲多久后释放 agent 进程                      |
| `allowedWorkingDirectoryRoots` | `string[]`                    | `/new <path>` 的目录白名单，不配表示不限制         |
| `messageTimestamp`             | `{timeZone} \| true \| false` | 在入站文本前加一行到达时间                         |
| `streaming`                    | boolean                       | `false` 时每轮只发一条完整消息，不再转发增量帧     |

## WeCom 通道行为

### 一次运行一个气泡

每条入站消息打开一条流式气泡。如果 agent 还在处理时又来一条消息，这条消息会并入当前运行而不是再开一条气泡，气泡里会说明这一点。气泡在 `agent_settled` 关闭，不在 `agent_end` 关闭，因为 pi 在 `agent_end` 之后仍可能重试、压缩或接受新指令。

### 步骤文案

agent 工作期间气泡只显示一行，从 70 条程序员风文案里随机抽取，并按工具调用固定下来，所以 `running`、`update`、`done` 事件不会来回换字。工具名、命令行、参数和结果都不会出现在聊天里。配置 `replyProgress: "log"` 可以回到逐个工具的日志样式。

一步完成后，`showStepResult` 会在下面追加一句状态提示。`stepResultDetail: "raw"` 则改为显示截断后的工具结果摘要。

正文与上一帧完全相同的帧会被直接跳过，那些帧只会重绘同样的文字。

### 心跳

长时间的单步会每隔 `stepHeartbeatMs` 给文案加一个轮转的点，默认 15 秒。每一帧都是整条正文重写，客户端每次都会重绘，所以这个间隔是在「看起来还活着」和「看得出闪烁」之间的取舍。设为 `0` 关闭。

### 答案在收尾帧落地

agent 工作期间答案不会流出。收尾帧携带完整答案并覆盖所有步骤文案，气泡最后只剩结果。正文超过 16KB 预算时，前半段留在气泡，剩余部分作为后续消息发出。这个 16KB 是给企业微信 20KB 单帧上限留的余量。

如果服务端已经关闭了流，通常是 10 分钟上限，bridge 会为同一条消息重开一条气泡把答案放进去，而不是退回成第二条聊天消息。

### 群聊：@ 与发言人

把 `botName` 配成机器人的显示名。这样只有点名该机器人的 @ 才算提及，括号里的别名会被忽略，所以 `@瓦达西(Vaddasi)` 和 `@瓦达西` 都能命中。不配 `botName` 时任意前导 `@` 都算，这是原有行为。两种情况都会把所有前导 `@name` 从 prompt 里剥掉。

群聊的 prompt 会带发言人标识，让 agent 知道是谁在问：

```
[speaker: u-2]
[quoted: 上一版的报错日志]
这个怎么办
```

企业微信不下发姓名，所以 `userLabels` 用来把 id 映射成可读名字，没映射的直接用 id。私聊不加这一行。

### 引用消息

用户引用一条消息再提问时，企业微信会把它放在 `body.quote` 里。引用文本会被压成一行并以 `[quoted: ...]` 前缀注入 prompt，agent 就能针对被引用的内容回答。图片、文件、语音引用只做标注，即 `[image]`、`[file]`、`[voice]`，不会下载。

### 回复点名

这一项目前只有纯文本一种可靠形式，默认关闭。

- `none`，默认值，回复不指向任何人
- `text`，在正文前加一个字面的 `@名字`，名字取 `userLabels` 映射，没映射时显示加密的 userid
- `markdown`，加 `<@userid>`。企业微信只在这条语法用于机器人 text/markdown 消息时解析它，智能机器人的流式帧会把整串原样显示，实测能在回复里看到裸露的 `<@woaz…>`。因此它不默认开启，保留只为兼容非流式场景

想要「看起来在点名」，用 `text` 并把常用的人写进 `userLabels`。真正触发对方提醒的 @ 在当前流式实现里做不到。

### 附件

发给机器人的图片和文件会下载到系统临时目录 `<tmp>/agent-bridge-wecom-media`，单个文件上限 20MB，prompt 里以路径引用。图文混排消息里的图片和文件也会一并下载，不会只留下文字。

企业微信里「先发文件再补一句话」是两条独立消息，不是一条混排。只有附件、没有文字的消息会先等 3 秒，把随后那句话合并成一条 prompt 再触发，避免为一串路径白跑一轮；窗口内没有文字就单独发出。超过 7 天的文件会在连接时清理一次，之后最多每小时检查一次。

### 欢迎语

每次有人打开机器人会话，企业微信都会发一个 `enter_chat` 事件。客户端从固定池里随机回一句，池子定义在 `src/modules/client/wecom/adapter/wecom-client.ts` 的 `WECOM_WELCOME_REPLIES`，避免一整天重复同一句问候。改池子要改这段数组并重新构建。

### 有界状态

回复上下文和流上下文只保留最近 500 条消息 id，已处理的消息 id 同样只保留 500 条。更早的数据只有永远不会到来的重试才需要。

## 斜杠命令

在适配器本地处理，不触碰 agent：

| 命令 | 说明 |
| ---- | ---- |
| `/help` `/h` | 显示命令列表 |
| `/think` | 级别非法或缺失，只回用法，不开气泡也不建会话 |
| `/schedule-run <任务名>` | 立即触发一次定时任务，结果发到它绑定的聊天 |
| `/schedule-here <任务名>` | 把当前聊天设为该任务的接收目标 |
| `/queue-here <队列名>` | 把当前聊天设为该队列的接收目标 |

交给核心处理，需要已有会话：

| 命令 | 说明 |
| ---- | ---- |
| `/status` `/st` | 会话 id、模型、思考强度、上下文用量 |
| `/model` `/m` | 列出模型，或用 `/model provider/modelId` 切换 |
| `/think <级别>` | 切换思考强度：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `/compact` `/c` | 压缩当前会话上下文 |
| `/stop` `/s` | 中止当前这一轮 |

会话生命周期：

| 命令 | 说明 |
| ---- | ---- |
| `/new [path]` `/n [path]` | 开新会话，可指定工作目录 |
| `/resume <id>` `/r <id>` | 接管一个已有的 provider 会话 |

`/status`、`/model`、`/think <级别>`、`/compact`、`/stop` 需要会话已经存在。在新聊天里直接发这些命令只会得到「暂时无法切换」之类的回复，不会为此拉起 agent 进程。

## 思考强度

pi 支持 `--thinking`，可选值是 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，也支持 `provider/model:级别` 的简写。启动级别通过 `agent.config.extraArgs` 设置，运行中的会话用 `/think` 切换。运行时切换不会在重启后保留。

## 日志

默认 `info` 级别。逐事件的细节，包括每个 SDK 帧、每条入站消息、每个转发的工具事件，都降到了 `debug`。需要这些信息时给服务加上 `LOG_LEVEL=debug`。

在 systemd 主机上，按周或按 20MB 轮转 `/root/.config/agent-bridge/*.log`，保留四份压缩历史。必须使用 `copytruncate`，因为 systemd 以追加方式持有该文件。

## 开发

```bash
npm install
npm run build
npm test
npm run dev -- --help
```

`npm run build` 用 tsup 把 `src/` 打包成 `dist/agent-bridge.js`。测试跑在 vitest 上。

目录：

- `src/core/` 核心网关：会话生命周期、命令路由、事件分发
- `src/modules/client/` IM 适配器，含 `wecom`、`weixin`、`feishu` 和共享的进度渲染
- `src/modules/agent/` agent 适配器，含 `pi-coding-agent`、`opencode`
- `src/modules/queue/`、`src/modules/schedule/` 队列与定时任务
- `src/i18n/` 进度文案和命令回复的 zh-CN / en-US 资源

## License

MIT
