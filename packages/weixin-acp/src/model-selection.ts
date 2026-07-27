import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MODEL_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CONCRETE_MODEL_PATTERN = /^(.+)\[([^\[\]]+)\]$/;
const ACP_MODEL_ID_PATTERN = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const MAX_MODEL_OPTIONS = 20;
const MAX_STATE_BYTES = 4096;

interface ModelSelectionState {
  version: 1;
  modelId: string;
  updatedAt: string;
}

export interface CodexModelSelectionConfig {
  strategy: "codex-family";
  allowlist: string[];
  store: ModelSelectionStore;
}

export interface AcpAdvertisedModelSelectionConfig {
  strategy: "acp-advertised";
  store: ModelSelectionStore;
}

export type ModelSelectionConfig =
  | CodexModelSelectionConfig
  | AcpAdvertisedModelSelectionConfig;

function validateModelFamily(modelId: string): string {
  const normalized = modelId.trim();
  if (!MODEL_FAMILY_PATTERN.test(normalized)) {
    throw new Error(`invalid model family: ${JSON.stringify(modelId)}`);
  }
  return normalized;
}

export interface ConcreteModelId {
  family: string;
  effort: string;
  modelId: string;
}

export function parseConcreteModelId(modelId: string): ConcreteModelId {
  const normalized = modelId.trim();
  const match = CONCRETE_MODEL_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(`invalid concrete model id: ${JSON.stringify(modelId)}`);
  }
  const family = validateModelFamily(match[1] ?? "");
  const effort = (match[2] ?? "").trim();
  if (!MODEL_EFFORT_PATTERN.test(effort)) {
    throw new Error(`invalid model effort: ${JSON.stringify(effort)}`);
  }
  return { family, effort, modelId: `${family}[${effort}]` };
}

export function parseModelAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const models = [...new Set(raw.split(",").map(validateModelFamily))];
  if (models.length > MAX_MODEL_OPTIONS) {
    throw new Error(`model allowlist exceeds ${MAX_MODEL_OPTIONS} entries`);
  }
  return models;
}

export function createModelSelectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): ModelSelectionConfig | null {
  const agentHome = env.WEIXIN_AGENT_HOME?.trim();
  const allowlist = parseModelAllowlist(env.WEIXIN_AGENT_MODEL_ALLOWLIST);
  if (allowlist.length === 0) return null;
  if (!agentHome) {
    throw new Error("WEIXIN_AGENT_HOME is required for model selection");
  }
  if (!path.isAbsolute(agentHome)) {
    throw new Error("WEIXIN_AGENT_HOME must be absolute for model selection");
  }
  return {
    strategy: "codex-family",
    allowlist,
    store: new ModelSelectionStore(
      path.join(agentHome, "channels", "wechat", "model-selection.json"),
      { strategy: "codex-family", allowlist },
    ),
  };
}

export type AcpBackend = "codex" | "claude" | "unsupported";

export function classifyAcpBackend(
  command: string,
  args: string[] = [],
): AcpBackend {
  const executable = path.basename(command).toLowerCase();
  const classifyPackage = (value: string | undefined): AcpBackend => {
    const normalized = value?.toLowerCase();
    if (
      normalized === "codex-acp"
      || normalized === "@agentclientprotocol/codex-acp"
    ) return "codex";
    if (
      normalized === "claude-agent-acp"
      || normalized === "@agentclientprotocol/claude-agent-acp"
    ) return "claude";
    return "unsupported";
  };
  if (executable === "codex-acp" || executable === "codex-acp.cmd") {
    return "codex";
  }
  if (
    executable === "claude-agent-acp"
    || executable === "claude-agent-acp.cmd"
  ) {
    return "claude";
  }
  if (["npx", "pnpx", "bunx"].includes(executable)) {
    const backendArg = args.find((arg) => arg !== "--" && !arg.startsWith("-"));
    return classifyPackage(backendArg);
  }
  if (executable === "pnpm") {
    const [subcommand, backendArg] = args;
    return subcommand === "dlx" || subcommand === "exec"
      ? classifyPackage(backendArg)
      : "unsupported";
  }
  if (executable === "yarn") {
    const [subcommand, backendArg] = args;
    return subcommand === "dlx"
      ? classifyPackage(backendArg)
      : "unsupported";
  }
  return "unsupported";
}

export function isCodexAcpBackend(
  command: string,
  args: string[] = [],
): boolean {
  return classifyAcpBackend(command, args) === "codex";
}

export function createBackendModelSelectionConfig(
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  createConfig: (source: NodeJS.ProcessEnv) => ModelSelectionConfig | null
    = createModelSelectionConfig,
): ModelSelectionConfig | null {
  const backend = classifyAcpBackend(command, args);
  if (backend === "codex") return createConfig(env);
  if (backend !== "claude") return null;

  const agentHome = env.WEIXIN_AGENT_HOME?.trim();
  if (!agentHome) {
    throw new Error("WEIXIN_AGENT_HOME is required for model selection");
  }
  if (!path.isAbsolute(agentHome)) {
    throw new Error("WEIXIN_AGENT_HOME must be absolute for model selection");
  }
  return {
    strategy: "acp-advertised",
    store: new ModelSelectionStore(
      path.join(agentHome, "channels", "wechat", "model-selection.json"),
      { strategy: "acp-advertised" },
    ),
  };
}

type StorePolicy =
  | { strategy: "codex-family"; allowlist: string[] }
  | { strategy: "acp-advertised" };

export class ModelSelectionStore {
  private readonly allowed: Set<string> | null;
  private readonly strategy: StorePolicy["strategy"];

  constructor(
    readonly filePath: string,
    policy: string[] | StorePolicy,
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("model selection state path must be absolute");
    }
    const normalizedPolicy: StorePolicy = Array.isArray(policy)
      ? { strategy: "codex-family", allowlist: policy }
      : policy;
    this.strategy = normalizedPolicy.strategy;
    this.allowed = normalizedPolicy.strategy === "codex-family"
      ? new Set(normalizedPolicy.allowlist.map(validateModelFamily))
      : null;
    if (this.allowed?.size === 0) {
      throw new Error("model selection allowlist must not be empty");
    }
  }

  read(): string | undefined {
    let initialStat: fs.Stats;
    try {
      initialStat = fs.lstatSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    this.assertSafeStateFile(initialStat);

    const fd = fs.openSync(
      this.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    let raw: string;
    try {
      const openedStat = fs.fstatSync(fd);
      this.assertSafeStateFile(openedStat);
      if (
        openedStat.dev !== initialStat.dev
        || openedStat.ino !== initialStat.ino
      ) {
        throw new Error("model selection state changed while opening");
      }
      if (openedStat.size > MAX_STATE_BYTES) {
        throw new Error("model selection state is too large");
      }
      raw = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }

    const parsed = JSON.parse(raw) as Partial<ModelSelectionState>;
    if (
      parsed.version !== 1
      || typeof parsed.modelId !== "string"
      || typeof parsed.updatedAt !== "string"
      || Number.isNaN(Date.parse(parsed.updatedAt))
    ) {
      throw new Error("model selection state schema is invalid");
    }
    return this.validatePersistedModelId(parsed.modelId);
  }

  write(modelId: string): void {
    const validatedModelId = this.validatePersistedModelId(modelId);

    const parent = path.dirname(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      this.assertSafeStateFile(fs.lstatSync(this.filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const state: ModelSelectionState = {
      version: 1,
      modelId: validatedModelId,
      updatedAt: new Date().toISOString(),
    };
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    const temp = path.join(
      parent,
      `.model-selection.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
      fs.writeFileSync(fd, bytes, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const dirFd = fs.openSync(parent, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try {
        fs.unlinkSync(temp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  clear(): void {
    let initialStat: fs.Stats;
    try {
      initialStat = fs.lstatSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    this.assertSafeStateFile(initialStat);
    const fd = fs.openSync(
      this.filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const openedStat = fs.fstatSync(fd);
      this.assertSafeStateFile(openedStat);
      if (
        openedStat.dev !== initialStat.dev
        || openedStat.ino !== initialStat.ino
      ) {
        throw new Error("model selection state changed while opening");
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.unlinkSync(this.filePath);
    const dirFd = fs.openSync(path.dirname(this.filePath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  private validatePersistedModelId(modelId: string): string {
    if (this.strategy === "acp-advertised") {
      if (!ACP_MODEL_ID_PATTERN.test(modelId)) {
        throw new Error(`invalid ACP model id: ${JSON.stringify(modelId)}`);
      }
      return modelId;
    }
    const concrete = parseConcreteModelId(modelId);
    if (!this.allowed?.has(concrete.family)) {
      throw new Error(`model is not in the allowlist: ${concrete.family}`);
    }
    return concrete.modelId;
  }

  private assertSafeStateFile(stat: fs.Stats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("model selection state must be a single regular file");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("model selection state permissions must be 0600");
    }
  }
}
