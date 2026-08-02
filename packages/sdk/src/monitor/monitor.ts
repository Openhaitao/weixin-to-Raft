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
/** How many recent deliveries to remember for de-dup. */
const SEEN_DELIVERY_MAX = 512;

/**
 * Bounded "have I already delivered this?" memory, used by the poll loop.
 * A class rather than an inline Set so the regression can drive the SAME code
 * the loop uses — testing an id helper alone would stay green even if the loop
 * stopped calling it, which is the defect this exists to prevent.
 */
export class DeliveryDeduper {
  private readonly seen = new Set<string>();
  constructor(private readonly max = SEEN_DELIVERY_MAX) {}

  /** True when this delivery has not been seen before (and records it). */
  admit(msg: Parameters<typeof messageDeliveryId>[0]): boolean {
    const id = messageDeliveryId(msg);
    // Unidentifiable ⇒ always deliver: a rare duplicate beats a dropped message.
    if (!id) return true;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    if (this.seen.size > this.max) {
      const keep = [...this.seen].slice(-Math.floor(this.max / 2));
      this.seen.clear();
      for (const k of keep) this.seen.add(k);
    }
    return true;
  }

  get size(): number { return this.seen.size; }
}

/**
 * Stable per-delivery identity. `message_id` is the server's own id; `seq`
 * disambiguates when it is absent. Returns "" when neither is usable, in which
 * case we deliver (better a rare duplicate than a dropped message).
 */
export function messageDeliveryId(msg: {
  message_id?: number; seq?: number; from_user_id?: string; create_time_ms?: number;
}): string {
  if (msg.message_id != null) return `m:${msg.message_id}`;
  if (msg.seq != null) return `s:${msg.from_user_id ?? ""}:${msg.seq}`;
  return "";
}

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
  const deduper = new DeliveryDeduper();

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
        // Deliver each message ONCE. The poll cursor only advances when the
        // server returns a non-empty get_updates_buf, so an empty buf re-serves
        // the same batch and the same message reaches the agent again — the
        // user sees one message answered twice, with the two replies talking
        // past each other (observed 2026-08-02 after a sidecar restart).
        // Identity-based de-dup holds regardless of what the cursor does.
        if (!deduper.admit(full)) {
          aLog.info(`skip duplicate delivery id=${messageDeliveryId(full)}`);
          continue;
        }
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
