import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MODEL_FAMILY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_EFFORT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const CONCRETE_MODEL_PATTERN = /^(.+)\[([^\[\]]+)\]$/;
const MAX_MODEL_OPTIONS = 20;
const MAX_STATE_BYTES = 4096;

interface ModelSelectionState {
  version: 1;
  modelId: string;
  updatedAt: string;
}

export interface ModelSelectionConfig {
  allowlist: string[];
  store: ModelSelectionStore;
}

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
    allowlist,
    store: new ModelSelectionStore(
      path.join(agentHome, "channels", "wechat", "model-selection.json"),
      allowlist,
    ),
  };
}

export function isCodexAcpBackend(
  command: string,
  args: string[] = [],
): boolean {
  const executable = path.basename(command).toLowerCase();
  const isCodexPackage = (value: string | undefined): boolean => {
    const normalized = value?.toLowerCase();
    return normalized === "codex-acp"
      || normalized === "@agentclientprotocol/codex-acp";
  };
  if (executable === "codex-acp" || executable === "codex-acp.cmd") {
    return true;
  }
  if (["npx", "pnpx", "bunx"].includes(executable)) {
    const backendArg = args.find((arg) => arg !== "--" && !arg.startsWith("-"));
    return isCodexPackage(backendArg);
  }
  if (executable === "pnpm") {
    const [subcommand, backendArg] = args;
    return (subcommand === "dlx" || subcommand === "exec")
      && isCodexPackage(backendArg);
  }
  if (executable === "yarn") {
    const [subcommand, backendArg] = args;
    return subcommand === "dlx" && isCodexPackage(backendArg);
  }
  return false;
}

export function createBackendModelSelectionConfig(
  command: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  createConfig: (source: NodeJS.ProcessEnv) => ModelSelectionConfig | null
    = createModelSelectionConfig,
): ModelSelectionConfig | null {
  return isCodexAcpBackend(command, args)
    ? createConfig(env)
    : null;
}

export class ModelSelectionStore {
  private readonly allowed: Set<string>;

  constructor(
    readonly filePath: string,
    allowlist: string[],
  ) {
    if (!path.isAbsolute(filePath)) {
      throw new Error("model selection state path must be absolute");
    }
    this.allowed = new Set(allowlist.map(validateModelFamily));
    if (this.allowed.size === 0) {
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
    const concrete = parseConcreteModelId(parsed.modelId);
    if (!this.allowed.has(concrete.family)) {
      throw new Error(`persisted model is not in the allowlist: ${concrete.family}`);
    }
    return concrete.modelId;
  }

  write(modelId: string): void {
    const concrete = parseConcreteModelId(modelId);
    if (!this.allowed.has(concrete.family)) {
      throw new Error(`model is not in the allowlist: ${concrete.family}`);
    }

    const parent = path.dirname(this.filePath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
      this.assertSafeStateFile(fs.lstatSync(this.filePath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const state: ModelSelectionState = {
      version: 1,
      modelId: concrete.modelId,
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

  private assertSafeStateFile(stat: fs.Stats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("model selection state must be a single regular file");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("model selection state permissions must be 0600");
    }
  }
}
