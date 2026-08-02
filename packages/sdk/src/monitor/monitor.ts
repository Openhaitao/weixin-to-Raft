import type { Agent } from "../agent/interface.js";
import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

/**
 * Graduated backoff. The poll cursor is NOT advanced on failure, so a blip
 * delays messages rather than losing them — the cost of a hiccup is purely
 * how long we stay away. Observed 2026-08-02: 146 of 160 transient failures
 * recovered on the first retry, yet three in a row jumped straight to a 30s
 * sleep, so a brief outage cost ~36s of silence ("怎么不说话了"). Doubling from
 * the retry delay keeps a short blip short and still protects a dead endpoint.
 */
export function pollBackoffMs(consecutiveFailures: number): number {
  const step = Math.max(1, consecutiveFailures);
  return Math.min(RETRY_DELAY_MS * 2 ** (step - 1), BACKOFF_DELAY_MS);
}

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
};

/**
 * Long-poll loop: getUpdates → process message → call agent → send reply.
 * Runs until aborted.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    agent,
    abortSignal,
    longPollTimeoutMs,
  } = opts;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    logger.error(msg);
  };
  const aLog = logger.withAccount(accountId);

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          errLog(
            `[weixin] session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing for ${Math.ceil(pauseMs / 60_000)} min. Please run \`npx weixin-acp login\` to re-login.`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[weixin] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        {
          const waitMs = pollBackoffMs(consecutiveFailures);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            errLog(`[weixin] ${consecutiveFailures} consecutive failures, backing off ${Math.round(waitMs / 1000)}s`);
          }
          await sleep(waitMs, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      for (const full of list) {
        aLog.info(
          `inbound: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const fromUserId = full.from_user_id ?? "";
        const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);

        await processOneMessage(full, {
          accountId,
          agent,
          baseUrl,
          cdnBaseUrl,
          token,
          typingTicket: cachedConfig.typingTicket,
          log,
          errLog,
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `[weixin] getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      {
        const waitMs = pollBackoffMs(consecutiveFailures);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`[weixin] ${consecutiveFailures} consecutive failures, backing off ${Math.round(waitMs / 1000)}s`);
        }
        await sleep(waitMs, abortSignal);
      }
    }
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
