# weixin-raft

微信 ↔ Raft Agent 路由桥。把绑定的微信接到一组白名单 Raft agent 上：默认发给一只
bot，在微信里发送 `/agent` 随时查看和切换。

```text
你的微信
  ↕ weixin-agent-sdk（扫码绑定、长轮询、消息收发）
weixin-raft（路由、/agent 菜单、去重、重启恢复）
  ↕ raft CLI（专用 External Agent 身份）
当前选中的 @code / @PM / @Buffett / …
```

## 使用

```bash
export RAFT_PROFILE=wechat-bridge          # 专用 Raft External Agent 的 profile
export WEIXIN_RAFT_AGENTS="code=技术开发,PM=产品研究,Buffett=投资研究"
export WEIXIN_RAFT_DEFAULT_AGENT=code      # 可选，默认取白名单第一项

weixin-raft doctor    # 校验 Raft 身份可用、白名单 agent 全部在线注册
weixin-raft login     # 微信扫码绑定（首次）
weixin-raft start     # 启动双向桥接
weixin-raft logout    # 清除微信绑定
```

微信里的交互：

- 直接发文字 → 转给当前选中的 agent，回复自动带 `来自 @xxx：` 标注回到微信。
- `/agent` → 数字菜单，回复编号切换（5 分钟内有效）。
- `/agent PM` → 直接切换，`@` 前缀和大小写都可以。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `RAFT_PROFILE` | 是 | 桥接专用 Raft External Agent 的 profile slug |
| `WEIXIN_RAFT_AGENTS` | 是 | 逗号分隔白名单，`名称=描述`，描述可省略 |
| `WEIXIN_RAFT_DEFAULT_AGENT` | 否 | 默认 agent，必须在白名单内 |
| `WEIXIN_RAFT_STATE_DIR` | 否 | 状态目录，默认 `~/.openclaw/weixin-raft` |
| `WEIXIN_RAFT_POLL_INTERVAL_MS` | 否 | Raft 收件箱兜底轮询间隔，默认 30000 |
| `WEIXIN_RAFT_ALLOW_AMBIENT` | 否 | `1` 时允许无 profile 用环境身份，仅限本机联调 |

## 设计边界

- **身份**：微信消息进入 Raft 时，发送者是桥接 agent 自己，正文标注「来自海涛
  绑定的微信」；桥不伪装任何 Raft 人类账号。
- **白名单**：只有 `WEIXIN_RAFT_AGENTS` 里的 agent 会出现在 `/agent` 菜单，
  也只有它们的 **DM 顶层回复** 会被转回微信；频道消息、线程回复、人类消息、
  白名单外 agent 一律不出境。
- **凭证**：默认强制 `RAFT_PROFILE` 专用身份，缺失即拒绝启动，不回落到环境里
  恰好存在的其他身份。
- **可靠性**：Raft → 微信方向持久化到磁盘队列，发送失败保留待发、成功才标记；
  按 Raft message id 去重，桥重启不重发。微信 → Raft 方向若命中草稿保护，会先
  排空收件箱再发送草稿。
- **收 Raft 回复**：`raft agent bridge --json` 提供 wake 信号，收到即拉取；另有
  轮询兜底。
- **MVP 范围**：单一微信绑定、纯文字双向。附件会收到明确的「暂不支持」提示，
  而不是被静默丢弃。

## 已知限制

- 桥主动发微信依赖最近一次微信入站缓存的 `context_token`（约 24 小时有效）。
  超时后 Raft 回复会留在磁盘队列里，等你在微信里再发一句话即补投。
- 一个桥进程服务一个微信绑定；多绑定需要各自的状态目录和 Raft profile。
