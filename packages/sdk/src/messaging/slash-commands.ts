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
}

export interface SlashCommandContext {
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
    return;
  }
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
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

function formatModelMenu(menu: AgentModelMenu): string {
  const lines = menu.options.map((option, index) => {
    const current = option.id === menu.currentModelId ? "（当前）" : "";
    return `${index + 1}. ${option.name}${current}`;
  });
  return [
    menu.currentModelId ? `当前模型：${menu.currentModelId}` : "当前模型：由 Agent 默认配置决定",
    "",
    ...lines,
    "",
    "请在 5 分钟内直接回复编号切换。切换后下一条消息生效。",
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
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
  selectionRegistry: ModelSelectionRegistry = modelSelections,
): Promise<SlashCommandResult> {
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
      return { handled: true };
    }
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/clear": {
        selectionRegistry.clear(ctx.accountId, ctx.to);
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true };
      }
      case "/new": {
        selectionRegistry.clear(ctx.accountId, ctx.to);
        ctx.onClear?.();
        await sendReply(ctx, "新会话已开始。我会从下一条消息开始按新的上下文处理。");
        return { handled: true };
      }
      case "/model": {
        try {
          if (!ctx.getModelMenu || !ctx.selectModel) {
            await sendReply(ctx, "当前 Agent 不支持切换模型。");
            return { handled: true };
          }
          const menu = await ctx.getModelMenu();
          if (menu.options.length === 0) {
            await sendReply(ctx, "候选工具链没有返回任何受审可选模型。");
            return { handled: true };
          }
          const directIndex = args.trim();
          if (directIndex) {
            const index = /^\d+$/.test(directIndex) ? Number(directIndex) - 1 : -1;
            await selectModel(
              ctx,
              Number.isSafeInteger(index) && index >= 0 ? menu.options[index] : undefined,
            );
            return { handled: true };
          }
          selectionRegistry.open(ctx.accountId, ctx.to, menu.options);
          await sendReply(ctx, formatModelMenu(menu));
          return { handled: true };
        } catch (err) {
          logger.error(`[weixin] Model command error: ${String(err)}`);
          await sendReply(ctx, "模型切换失败，候选工具链未接受该模型。请重新发送 /model。");
          return { handled: true };
        }
      }
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}
