# weixin-to-Raft

> This is not an official WeChat project. The code is adapted from [@tencent-weixin/openclaw-weixin](https://npmx.dev/package/@tencent-weixin/openclaw-weixin) and is intended for learning and research purposes.

Connect your AI agents to WeChat. The flagship use case: **bridge WeChat to a [Raft](https://raft.build) multi-agent collaboration server** — chat with any agent on your Raft server directly from WeChat and switch between them with `/agent` at any time. You can also use the underlying SDK to plug any AI backend into WeChat.

## WeChat ↔ Raft

```text
Your WeChat
  ↕ weixin-agent-sdk (QR binding, long polling — no public server needed)
weixin-raft (routing, /agent menu, synchronous wait, dedupe, restart recovery)
  ↕ raft CLI (dedicated External Agent identity)
Any agent on your Raft server
```

The experience reads like a normal WeChat conversation:

- Send text or attachments → they go to the currently selected agent. A typing indicator shows while you wait, and answers arriving within the window (90s by default) appear as direct replies — no relay notices, no prefixes.
- `/agent` → a live list of every online agent on the server; reply with a number or `/agent name` to switch. Newly added agents show up automatically with zero configuration.
- Attachments forward in both directions: WeChat images/files/videos/voice become Raft attachments for the agent; attachments on agent replies come back to WeChat as real media.
- If a task runs long, you get one clear notice at timeout, and the answer is delivered later labeled `来自 @xxx`.

### Quick start

1. **Create the bridge identity**: in Raft's sidebar agents area, click **+** → **Create External Agent** (not a regular agent — the bridge process itself is its runtime).
2. **Log in**: follow the new agent's External Setup card and run
   `raft agent login --server <url> --agent <id> --profile-slug wechat-bridge`,
   then approve once in the browser.
3. **Bind WeChat and start**:

```bash
export RAFT_PROFILE=wechat-bridge
export WEIXIN_RAFT_DEFAULT_AGENT=code   # the default agent to talk to

pnpm install && pnpm -r run build
pnpm --filter weixin-raft exec tsx main.ts doctor   # verify identity + default agent
pnpm --filter weixin-raft exec tsx main.ts login    # scan the QR code with WeChat
pnpm --filter weixin-raft exec tsx main.ts start    # start the bidirectional bridge
```

For production, run it under launchd/systemd. Full environment variables, reliability semantics (durable disk queue, per-message dedupe, restart recovery, draft protection) and identity boundaries are documented in
[`packages/weixin-raft/README.md`](packages/weixin-raft/README.md).

### Design boundaries

- The bridge uses a dedicated Raft External Agent identity and clearly labels the origin of every message entering Raft — it **never impersonates a human account**. It refuses to start without `RAFT_PROFILE` rather than falling back to an ambient identity.
- Only an agent's own top-level DM replies leave Raft for WeChat; channel messages, threads, and human messages never do.
- The Raft → WeChat direction is persisted in a durable on-disk queue: failed sends are retried, deliveries are deduped by message id, and restarts never resend.

## Repository layout

```
packages/
  sdk/                  weixin-agent-sdk — the WeChat bridge SDK
  weixin-raft/          the WeChat ↔ Raft router bridge (this repo's flagship app)
  weixin-acp/           ACP (Agent Client Protocol) adapter
  example-openai/       an OpenAI-based example
```

## Connect Claude Code, Codex, kimi-cli and other agents via ACP

[ACP (Agent Client Protocol)](https://agentclientprotocol.com/) is an open agent communication protocol. If you already have an ACP-compatible agent, [`weixin-acp`](https://www.npmjs.com/package/weixin-acp) connects it to WeChat without writing any code.

### Claude Code

```bash
npx weixin-acp claude-code
```

### Codex

```bash
npx weixin-acp codex
```

### Other ACP agents

For example, kimi-cli:

```bash
npx weixin-acp start -- kimi acp
```

Everything after `--` is your ACP agent's launch command; `weixin-acp` starts it as a child process and talks JSON-RPC over stdio.

See the [ACP agent list](https://agentclientprotocol.com/get-started/agents) for more compatible agents.

## Custom agents

The SDK exports three main things:

- **`Agent`** — implement this interface to connect to WeChat
- **`login()`** — QR-code login
- **`start(agent)`** — starts the message loop and immediately returns a `Bot` that can send proactive messages

### The Agent interface

```typescript
interface Agent {
  chat(request: ChatRequest): Promise<ChatResponse>;
}

interface ChatRequest {
  conversationId: string;         // user identifier, for multi-turn context
  text: string;                   // text content
  media?: {                       // attachment (image/audio/video/file)
    type: "image" | "audio" | "video" | "file";
    filePath: string;             // local file path (already downloaded & decrypted)
    mimeType: string;
    fileName?: string;
  };
}

interface ChatResponse {
  text?: string;                  // reply text (markdown is converted to plain text before sending)
  media?: {                       // reply media
    type: "image" | "video" | "file";
    url: string;                  // local path or HTTPS URL
    fileName?: string;
  };
}
```

### Minimal example

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const echo: Agent = {
  async chat(req) {
    return { text: `You said: ${req.text}` };
  },
};

await login();
const bot = start(echo);
await bot.wait();
```

### Full example (managing conversation history yourself)

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const conversations = new Map<string, string[]>();

const myAgent: Agent = {
  async chat(req) {
    const history = conversations.get(req.conversationId) ?? [];
    history.push(req.text);

    // call your AI service...
    const reply = await callMyAI(history);

    history.push(reply);
    conversations.set(req.conversationId, history);
    return { text: reply };
  },
};

await login();
const bot = start(myAgent);
await bot.wait();
```

### Proactive messages

`start()` returns a `Bot` immediately. Besides replying to incoming messages, `bot.sendMessage()` lets you push content to the logged-in user; CLI programs can use `bot.wait()` to block until the message loop stops.

```typescript
import { login, start, type Agent } from "weixin-agent-sdk";

const agent: Agent = {
  async chat(req) {
    if (req.text === "ping") {
      return { text: "pong" };
    }
    return { text: `Received: ${req.text}` };
  },
};

await login();
const bot = start(agent);

setInterval(() => {
  void bot.sendMessage("Scheduled reminder: check the latest status");
}, 60_000);

await bot.wait();
```

You can also send a full `ChatResponse`, including images, video, or files:

```typescript
await bot.sendMessage({
  text: "Here is the latest report",
  media: {
    type: "file",
    url: "./reports/daily.pdf",
    fileName: "daily.pdf",
  },
});
```

Notes:

- Proactive sending depends on a `context_token` issued by WeChat
- At least one inbound message must have been received for the current account while `start()` is running
- The `context_token` expires (roughly 24 hours); after expiry, a new inbound message is needed before proactive sending works again

### OpenAI example

`packages/example-openai/` is a complete OpenAI agent implementation with multi-turn conversation and image input:

```bash
pnpm install

# QR-code login
pnpm run login -w packages/example-openai

# start the bot
OPENAI_API_KEY=sk-xxx pnpm run start -w packages/example-openai
```

Supported environment variables:

| Variable | Required | Description |
|------|------|------|
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_BASE_URL` | No | Custom API endpoint (OpenAI-compatible services) |
| `OPENAI_MODEL` | No | Model name, default `gpt-5.4` |
| `SYSTEM_PROMPT` | No | System prompt |

## Supported message types

### Receiving (WeChat → Agent)

| Type | `media.type` | Notes |
|------|-------------|------|
| Text | — | delivered directly as `request.text` |
| Image | `image` | auto-downloaded from CDN and decrypted; `filePath` points to a local file |
| Voice | `audio` | SILK auto-converted to WAV (requires `silk-wasm`) |
| Video | `video` | auto-downloaded and decrypted |
| File | `file` | auto-downloaded and decrypted, original filename preserved |
| Quoted message | — | quoted text is merged into `request.text`; quoted media arrives as `media` |
| Voice-to-text | — | WeChat's transcription arrives directly as `request.text` |

### Sending (Agent → WeChat)

| Type | Usage |
|------|------|
| Text | return `{ text: "..." }` |
| Image | return `{ media: { type: "image", url: "/path/to/img.png" } }` |
| Video | return `{ media: { type: "video", url: "/path/to/video.mp4" } }` |
| File | return `{ media: { type: "file", url: "/path/to/doc.pdf" } }` |
| Text + media | return both `text` and `media`; the text is sent as a caption |
| Remote image | pass an HTTPS URL; the SDK downloads and uploads it to the WeChat CDN |
| Proactive | call `bot.sendMessage(...)` on the `Bot` returned by `start(agent)` |

## Built-in slash commands

Send these in WeChat:

- `/echo <message>` — reply directly (bypassing the Agent), with channel timing stats
- `/toggle-debug` — toggle debug mode; when on, every reply appends end-to-end timing

## Technical details

- Messages are received via **long polling** (`getUpdates`) — no public server needed
- Media transits the WeChat CDN with **AES-128-ECB** encryption
- Single-account mode: each `login` replaces the previous account
- Resumable: `get_updates_buf` is persisted to `~/.openclaw/`, so restarts continue from the last position
- Automatic reconnection on session expiry (errcode -14 triggers a 1-hour cooldown before recovery)
- Node.js >= 22

## Star History

<a href="https://www.star-history.com/?repos=wong2%2Fweixin-agent-sdk&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=wong2/weixin-agent-sdk&type=date&legend=top-left" />
 </picture>
</a>
