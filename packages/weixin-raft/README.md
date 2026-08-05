# weixin-raft

The WeChat ↔ Raft agent router. Binds one WeChat account to your whole [Raft](https://raft.build) server: messages go to a default agent, and `/agent` lists every online agent live so you can switch at any time — newly added agents appear in the menu with no configuration change. A static allowlist is available via `WEIXIN_RAFT_AGENTS` if you prefer to pin the roster.

```text
Your WeChat
  ↕ weixin-agent-sdk (QR binding, long polling, send/receive)
weixin-raft (routing, /agent menu, sync wait, dedupe, restart recovery)
  ↕ raft CLI (dedicated External Agent identity)
The currently selected @agent
```

## Usage

```bash
export RAFT_PROFILE=wechat-bridge          # profile of the dedicated Raft External Agent
export WEIXIN_RAFT_DEFAULT_AGENT=code      # optional, defaults to code

weixin-raft doctor    # verify the Raft identity works and the default agent is online
weixin-raft login     # bind WeChat via QR code (first run)
weixin-raft start     # start the bidirectional bridge
weixin-raft logout    # clear the WeChat binding
```

In WeChat:

- Send text or attachments → forwarded to the currently selected agent. A typing indicator shows while waiting; answers within the window (about 90s) appear as direct replies with no prefix — the conversation reads like talking to that agent in person.
- On timeout you get one honest notice; the answer still arrives later, labeled `来自 @xxx` (late answers need attribution — after switching agents you couldn't otherwise tell who's speaking).
- `/agent` → a live numbered menu of all online agents; reply with a number to switch (valid for 5 minutes; numbers bind to the exact menu you saw, so agents coming online mid-choice can never hijack your selection).
- `/agent PM` → switch directly; `@` prefixes and any casing are accepted.
- `/help` → usage summary.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `RAFT_PROFILE` | Yes | Profile slug of the bridge's dedicated Raft External Agent |
| `WEIXIN_RAFT_DEFAULT_AGENT` | No | Default agent, `code` by default |
| `WEIXIN_RAFT_AGENTS` | No | Static allowlist `name=description,…`; unset (or `all`/`*`) = dynamic mode |
| `WEIXIN_RAFT_EXCLUDE` | No | Agents hidden from the dynamic menu whose replies never leave Raft |
| `WEIXIN_RAFT_STATE_DIR` | No | State directory, default `~/.openclaw/weixin-raft` |
| `WEIXIN_RAFT_POLL_INTERVAL_MS` | No | Fallback inbox polling interval, default 30000 |
| `WEIXIN_RAFT_SYNC_WAIT_MS` | No | How long to wait for a synchronous answer before going async, default 90000 |
| `WEIXIN_RAFT_ALLOW_AMBIENT` | No | `1` allows running without a profile on the ambient identity — local debugging only |

## Design boundaries

- **Identity**: messages entering Raft are sent by the bridge agent itself, with the body labeled as coming from the bound WeChat; the bridge never impersonates a human Raft account.
- **Egress rule**: only an agent's own **top-level DM replies** are relayed back to WeChat — the bridge identity's inbox only ever contains conversations the bridge itself started, so this is equivalent to "only echoes of bridged requests leave". Channel messages, thread replies, human messages, and excluded (or non-allowlisted) agents never leave Raft.
- **Credentials**: a dedicated `RAFT_PROFILE` identity is mandatory by default; the bridge refuses to start rather than falling back to whatever identity happens to be in the environment.
- **Attachments, both directions**: WeChat images/files/videos/voice are uploaded as Raft attachments and forwarded with the message; the bridge imposes no size policy of its own — the only limit is the Raft server's attachment endpoint (50MB today), and its rejection reason is relayed to the user. Attachments on agent replies are downloaded and sent back to WeChat as image/video/file; one attachment per message is forwarded, the rest are named in the text.
- **Reliability**: the Raft → WeChat direction is persisted in an on-disk queue — failed sends stay pending, only confirmed deliveries are marked, and messages are deduped by Raft message id across restarts. If a WeChat → Raft send hits draft protection, the bridge drains the inbox before resending the saved draft.
- **Receiving Raft replies**: `raft agent bridge --json` provides wake signals for immediate pickup, with polling as a fallback.
- **Scope**: one WeChat binding per bridge process; WeChat voice transcription is supported natively by the SDK and forwarded as text.

## Known limitations

- Proactive delivery to WeChat depends on a `context_token` cached from the most recent WeChat inbound message (valid ~24 hours). After it expires, Raft replies queue on disk and are delivered as soon as you send anything from WeChat.
- One bridge process serves one WeChat binding; multiple bindings need separate state directories and Raft profiles.
