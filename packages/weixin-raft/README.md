# weixin-raft

微信 ↔ Raft Agent 路由桥。把绑定的微信接到整个 Raft：默认发给一只 bot，在微信里
发送 `/agent` 实时列出服务器上全部在线 agent 并随时切换——新加入的 agent 自动出
现在菜单里，无需改配置。也可以用 `WEIXIN_RAFT_AGENTS` 锁定一个静态白名单。

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
export WEIXIN_RAFT_DEFAULT_AGENT=code      # 可选，默认 code

weixin-raft doctor    # 校验 Raft 身份可用、默认 agent 在线
weixin-raft login     # 微信扫码绑定（首次）
weixin-raft start     # 启动双向桥接
weixin-raft logout    # 清除微信绑定
```

微信里的交互：

- 直接发文字或附件 → 转给当前选中的 agent。等待期间显示「正在输入…」，约 90 秒
  内的回答直接作为回复出现，不带任何前缀——读起来就是在和该 agent 本人对话。
- `/help` → 查看用法说明。
- 慢任务超时后本轮静默结束，回答稍后送达并标注 `来自 @xxx：`（迟到的回答需要
  署名，否则切换过 agent 后无法分辨是谁在说话）。
- `/agent` → 实时列出全部在线 agent 的数字菜单，回复编号切换（5 分钟内有效；
  编号以你看到的那份菜单为准，中途上线的新 agent 不会顶掉你的选择）。
- `/agent PM` → 直接切换，`@` 前缀和大小写都可以。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `RAFT_PROFILE` | 是 | 桥接专用 Raft External Agent 的 profile slug |
| `WEIXIN_RAFT_DEFAULT_AGENT` | 否 | 默认 agent，默认 `code` |
| `WEIXIN_RAFT_AGENTS` | 否 | 静态白名单 `名称=描述,…`；不设或设 `all`/`*` 为动态模式 |
| `WEIXIN_RAFT_EXCLUDE` | 否 | 动态模式下从菜单隐藏、且回复不出境的 agent |
| `WEIXIN_RAFT_STATE_DIR` | 否 | 状态目录，默认 `~/.openclaw/weixin-raft` |
| `WEIXIN_RAFT_POLL_INTERVAL_MS` | 否 | Raft 收件箱兜底轮询间隔，默认 30000 |
| `WEIXIN_RAFT_SYNC_WAIT_MS` | 否 | 同步等待回答的时长，超时转异步送达，默认 90000 |
| `WEIXIN_RAFT_ALLOW_AMBIENT` | 否 | `1` 时允许无 profile 用环境身份，仅限本机联调 |

## 设计边界

- **身份**：微信消息进入 Raft 时，发送者是桥接 agent 自己，正文标注「来自海涛
  绑定的微信」；桥不伪装任何 Raft 人类账号。
- **出境规则**：只有 agent 自己 DM 里的 **顶层回复** 会被转回微信——桥身份的
  收件箱里只会有它自己发起的对话，所以这等价于「只转桥代发请求的回音」。频道
  消息、线程回复、人类消息、`WEIXIN_RAFT_EXCLUDE`（或静态白名单外）的 agent
  一律不出境。
- **凭证**：默认强制 `RAFT_PROFILE` 专用身份，缺失即拒绝启动，不回落到环境里
  恰好存在的其他身份。
- **可靠性**：Raft → 微信方向持久化到磁盘队列，发送失败保留待发、成功才标记；
  按 Raft message id 去重，桥重启不重发。微信 → Raft 方向若命中草稿保护，会先
  排空收件箱再发送草稿。
- **收 Raft 回复**：`raft agent bridge --json` 提供 wake 信号，收到即拉取；另有
  轮询兜底。
- **附件双向**：微信发来的图片/文件/视频/语音自动上传为 Raft 附件随消息转发；
  桥自身不设大小限制，唯一的上限来自 Raft 服务器附件接口（当前 50MB），被拒绝
  时会把原因回给用户。agent 回复携带的附件自动下载并作为图片/视频/文件发回
  微信，每条消息转发第一个附件，其余在文字中列名。
- **范围**：单一微信绑定；微信语音转写文字由 SDK 原生支持，直接作为文本转发。

## 已知限制

- 桥主动发微信依赖最近一次微信入站缓存的 `context_token`（约 24 小时有效）。
  超时后 Raft 回复会留在磁盘队列里，等你在微信里再发一句话即补投。
- 一个桥进程服务一个微信绑定；多绑定需要各自的状态目录和 Raft profile。
