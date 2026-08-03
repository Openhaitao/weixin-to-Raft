import os from "node:os";
import path from "node:path";

export interface RaftAgentOption {
  name: string;
  description?: string;
}

export interface WeixinRaftConfig {
  /**
   * Static allowlist. Undefined means dynamic mode: the /agent menu is built
   * live from the server's active agent list on every request, so newly
   * added agents appear without any configuration change.
   */
  agents?: RaftAgentOption[];
  /** Agents hidden from the dynamic menu and never relayed back to WeChat. */
  excludeAgents: string[];
  defaultAgent: string;
  raftProfile?: string;
  raftBin: string;
  stateDir: string;
  pollIntervalMs: number;
  allowAmbientAuth: boolean;
}

export function normalizeAgentName(value: string): string {
  return value.trim().replace(/^@/, "");
}

function parseAgent(raw: string): RaftAgentOption {
  const [rawName, ...descriptionParts] = raw.split("=");
  const name = normalizeAgentName(rawName ?? "");
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid Raft agent name: ${rawName || "(empty)"}`);
  }
  const description = descriptionParts.join("=").trim();
  return { name, ...(description ? { description } : {}) };
}

export function parseAgentList(raw: string): RaftAgentOption[] {
  const agents = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(parseAgent);
  if (agents.length === 0) {
    throw new Error("WEIXIN_RAFT_AGENTS must contain at least one Raft agent");
  }
  const keys = new Set<string>();
  for (const agent of agents) {
    const key = agent.name.toLowerCase();
    if (keys.has(key)) throw new Error(`Duplicate Raft agent: ${agent.name}`);
    keys.add(key);
  }
  return agents;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got: ${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WeixinRaftConfig {
  const rawAgents = env.WEIXIN_RAFT_AGENTS?.trim();
  const dynamic = !rawAgents || rawAgents === "all" || rawAgents === "*";
  const agents = dynamic ? undefined : parseAgentList(rawAgents);

  const requestedDefault = normalizeAgentName(
    env.WEIXIN_RAFT_DEFAULT_AGENT ?? (agents ? agents[0]!.name : "code"),
  );
  let defaultAgent = requestedDefault;
  if (agents) {
    const member = agents.find(
      (agent) => agent.name.toLowerCase() === requestedDefault.toLowerCase(),
    );
    if (!member) {
      throw new Error(`WEIXIN_RAFT_DEFAULT_AGENT is not in WEIXIN_RAFT_AGENTS: ${requestedDefault}`);
    }
    defaultAgent = member.name;
  }

  const excludeAgents = (env.WEIXIN_RAFT_EXCLUDE ?? "")
    .split(",")
    .map((item) => normalizeAgentName(item))
    .filter(Boolean);

  const openclawDir = env.OPENCLAW_STATE_DIR?.trim()
    || env.CLAWDBOT_STATE_DIR?.trim()
    || path.join(os.homedir(), ".openclaw");
  return {
    agents,
    excludeAgents,
    defaultAgent,
    raftProfile: env.RAFT_PROFILE?.trim() || undefined,
    raftBin: env.RAFT_BIN?.trim() || "raft",
    stateDir: env.WEIXIN_RAFT_STATE_DIR?.trim() || path.join(openclawDir, "weixin-raft"),
    pollIntervalMs: positiveInteger(env.WEIXIN_RAFT_POLL_INTERVAL_MS, 30_000),
    allowAmbientAuth: env.WEIXIN_RAFT_ALLOW_AMBIENT === "1",
  };
}

export function requireBridgeCredential(config: WeixinRaftConfig): void {
  if (!config.raftProfile && !config.allowAmbientAuth) {
    throw new Error(
      "RAFT_PROFILE is required. Create a dedicated Raft External Agent and set its profile slug.",
    );
  }
}
