import type { Agent } from "../agent/interface.js";
import { getUpdates, notifyStart } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { DeliveryLedger, getDeliveryLedgerPath, messageDeliveryId } from "../storage/delivery-ledger.js";
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
  /** Test seams. Production leaves these undefined and uses the real
   * implementations; without them this loop cannot be driven at all, so a
   * wiring defect could only ever be found in production. */
  __getUpdatesForTest?: typeof getUpdates;
  __processOneMessageForTest?: typeof processOneMessage;
  __ledgerPathForTest?: string;
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
  const doGetUpdates = opts.__getUpdatesForTest ?? getUpdates;
  const doProcessOneMessage = opts.__processOneMessageForTest ?? processOneMessage;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    logger.error(msg);
  };
  const aLog = logger.withAccount(accountId);

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  // 跟微信打个招呼：这个 bot 上线了。官方客户端每次启动都会发，我们一直没发。
  // 尽力而为 —— 打招呼失败不该拦住 bot 干活。
  void notifyStart({ baseUrl, token })
    .then(() => aLog.info("notifyStart ok"))
    .catch((err) => aLog.warn(`notifyStart failed (ignored): ${String(err)}`));

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  // Survives restarts: the duplicate we actually hit came from a fresh process
  // re-answering what the previous one had already answered.
  const ledger = new DeliveryLedger(opts.__ledgerPathForTest ?? getDeliveryLedgerPath(syncFilePath));
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
      const resp = await doGetUpdates({
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
        // Skip only what a PREVIOUS successful handling already committed.
        if (ledger.has(full)) {
          aLog.info(`skip already-handled delivery id=${messageDeliveryId(full)}`);
          continue;
        }
        aLog.info(
          `inbound: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        const fromUserId = full.from_user_id ?? "";
        const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);

        const outcome = await doProcessOneMessage(full, {
          accountId,
          agent,
          baseUrl,
          cdnBaseUrl,
          token,
          typingTicket: cachedConfig.typingTicket,
          log,
          errLog,
        });
        // Commit ONLY on success: a failed turn must stay eligible for the
        // server's redelivery, which is the user's one remaining chance.
        if (outcome.durable) {
          ledger.commit(full);
          // Material this turn consumed is durable now that the reply is out,
          // so those earlier messages retire with it and cannot come back as
          // pending material after a restart.
          for (const id of outcome.commitIds) ledger.commitId(id);
        }
        // A turn whose only effect was an in-memory stash is deliberately NOT
        // recorded: the ledger outliving the material is exactly how a message
        // gets swallowed. A re-serve is absorbed by the inbox's own dedupe,
        // which shares the material's lifetime.
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
