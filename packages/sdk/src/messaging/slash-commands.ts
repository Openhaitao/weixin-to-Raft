/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /clear                  清除当前会话，重新开始对话
 * - /new                    /clear 的别名，开启当前微信用户的新会话
 * - /model                  展示当前 Agent 的受审模型菜单
 */
import type {
  AgentModelMenu,
  AgentModelOption,
  AgentModelSelection,
} from "../agent/interface.js";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";

import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
  /**
   * 是否真的有一条回复发出去了。
   *
   * handled=true 只说明"这条走了指令分支"，不代表用户收到了东西：出错分支会先
   * 尝试发错误回复，而那条也可能失败。调用方拿它当"已送达"来去重的话，这条消息
   * 就被永久吞掉了——所以送达权威只能来自这里。
   */
  replied: boolean;
}

export interface SlashCommandContext {
  /** 每成功发出一条回复调用一次。由 handleSlashCommand 内部接线。 */
  onSent?: () => void;
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void;
  getModelMenu?: () => Promise<AgentModelMenu>;
  selectModel?: (modelId: string) => Promise<AgentModelSelection>;
  /** Test seam for command replies. Production uses the WeChat API. */
  reply?: (text: string) => Promise<void>;
}

interface PendingModelSelection {
  expiresAt: number;
  options: AgentModelOption[];
}

export interface PendingModelMatch {
  matched: boolean;
  option?: AgentModelOption;
}

const DEFAULT_MODEL_SELECTION_TTL_MS = 5 * 60 * 1000;

export class ModelSelectionRegistry {
  private readonly pending = new Map<string, PendingModelSelection>();

  constructor(
    private readonly ttlMs = DEFAULT_MODEL_SELECTION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  open(accountId: string, conversationId: string, options: AgentModelOption[]): void {
    this.pending.set(this.key(accountId, conversationId), {
      expiresAt: this.now() + this.ttlMs,
      options: options.map((option) => ({ ...option })),
    });
  }

  take(accountId: string, conversationId: string, text: string): PendingModelMatch {
    const key = this.key(accountId, conversationId);
    const pending = this.pending.get(key);
    if (!pending) return { matched: false };
    if (pending.expiresAt <= this.now()) {
      this.pending.delete(key);
      return { matched: false };
    }

    const trimmed = text.trim();
    if (!/^\d+$/.test(trimmed)) return { matched: false };
    this.pending.delete(key);
    const index = Number(trimmed) - 1;
    return {
      matched: true,
      option: Number.isSafeInteger(index) ? pending.options[index] : undefined,
    };
  }

  clear(accountId: string, conversationId: string): void {
    this.pending.delete(this.key(accountId, conversationId));
  }

  private key(accountId: string, conversationId: string): string {
    return `${accountId}\u0000${conversationId}`;
  }
}

const modelSelections = new ModelSelectionRegistry();

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  if (ctx.reply) {
    await ctx.reply(text);
    ctx.onSent?.();
    return;
  }
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
  ctx.onSent?.();
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

// Display-only Chinese blurbs for known model ids. Unknown/new models fall
// back to the advertised description so the menu never loses an entry —
// the option list itself always comes from the runtime ACP handshake.
const MODEL_BLURBS: Record<string, string> = {
  sonnet: "日常任务，快速高效",
  opus: "复杂任务首选",
  fable: "最强能力，适合最难最长的任务（耗用量大）",
  haiku: "最快响应，适合简单问题",
};

/** Full display name, e.g. "Opus 5": the description's first ·-segment
 * carries family+version; fall back to the advertised name, then the id. */
function modelDisplayName(option: AgentModelMenu["options"][number]): string {
  const versioned = option.description?.split("·")[0]?.trim();
  return versioned || option.name || option.id;
}

function formatModelMenu(menu: AgentModelMenu): string {
  const current = menu.options.find(
    (option) => option.id === menu.currentModelId,
  );
  const lines = menu.options.map((option, index) => {
    const isCurrent = option.id === menu.currentModelId;
    const blurb = MODEL_BLURBS[option.id]
      ?? MODEL_BLURBS[option.name?.toLowerCase() ?? ""]
      ?? option.description
      ?? "";
    return `${index + 1}. ${option.name}${isCurrent ? " ✓" : ""}`
      + `${blurb ? ` — ${blurb}` : ""}${isCurrent ? "（当前）" : ""}`;
  });
  return [
    current
      ? `当前模型：${modelDisplayName(current)}`
      : "当前模型：由 Agent 默认配置决定",
    "",
    ...lines,
    "",
    "回复编号即可切换，5 分钟内有效。",
  ].join("\n");
}

async function selectModel(
  ctx: SlashCommandContext,
  option: AgentModelOption | undefined,
): Promise<void> {
  if (!option) {
    await sendReply(ctx, "这个编号不在当前模型列表里。请重新发送 /model。");
    return;
  }
  if (!ctx.selectModel) {
    await sendReply(ctx, "当前 Agent 不支持切换模型。");
    return;
  }
  const selected = await ctx.selectModel(option.id);
  await sendReply(
    ctx,
    `已切换到 ${selected.name}（${selected.modelId}）。下一条消息会使用新模型和新会话。`,
  );
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  inputCtx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
  selectionRegistry: ModelSelectionRegistry = modelSelections,
): Promise<SlashCommandResult> {
  // Every send in this file funnels through sendReply, so one hook there is a
  // complete record of whether the user actually heard back.
  let replied = false;
  const ctx: SlashCommandContext = {
    ...inputCtx,
    onSent: () => {
      replied = true;
      inputCtx.onSent?.();
    },
  };
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    const pending = selectionRegistry.take(ctx.accountId, ctx.to, trimmed);
    if (pending.matched) {
      try {
        await selectModel(ctx, pending.option);
      } catch (err) {
        logger.error(`[weixin] Model selection error: ${String(err)}`);
        await sendReply(ctx, "模型切换失败，候选工具链未接受该模型。请重新发送 /model。");
      }
      return { handled: true, replied };
    }
    return { handled: false, replied };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true, replied };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true, replied };
      }
      case "/clear": {
        selectionRegistry.clear(ctx.accountId, ctx.to);
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true, replied };
      }
      case "/new": {
        selectionRegistry.clear(ctx.accountId, ctx.to);
        ctx.onClear?.();
        await sendReply(ctx, "新会话已开始。我会从下一条消息开始按新的上下文处理。");
        return { handled: true, replied };
      }
      case "/model": {
        try {
          if (!ctx.getModelMenu || !ctx.selectModel) {
            await sendReply(ctx, "当前 Agent 不支持切换模型。");
            return { handled: true, replied };
          }
          const menu = await ctx.getModelMenu();
          if (menu.options.length === 0) {
            await sendReply(ctx, "候选工具链没有返回任何受审可选模型。");
            return { handled: true, replied };
          }
          const directIndex = args.trim();
          if (directIndex) {
            const index = /^\d+$/.test(directIndex) ? Number(directIndex) - 1 : -1;
            await selectModel(
              ctx,
              Number.isSafeInteger(index) && index >= 0 ? menu.options[index] : undefined,
            );
            return { handled: true, replied };
          }
          selectionRegistry.open(ctx.accountId, ctx.to, menu.options);
          await sendReply(ctx, formatModelMenu(menu));
          return { handled: true, replied };
        } catch (err) {
          logger.error(`[weixin] Model command error: ${String(err)}`);
          await sendReply(ctx, "模型切换失败，候选工具链未接受该模型。请重新发送 /model。");
          return { handled: true, replied };
        }
      }
      default:
        return { handled: false, replied };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true, replied };
  }
}
