export function resolveStartArgs(rest, cwd, systemPromptFile, memoryDir) {
  const ddIndex = rest.indexOf("--");
  const common = [
    "start",
    "--cwd", cwd,
    "--system-prompt-file", systemPromptFile,
    "--memory-dir", memoryDir,
    "--",
  ];
  if (ddIndex === -1) {
    return [...common, "claude-agent-acp"];
  }
  const acpArgs = rest.slice(ddIndex + 1);
  if (acpArgs.length === 0) {
    throw new Error("missing ACP command after --");
  }
  return [...common, ...acpArgs];
}

export function buildBotPath(agentHome, currentPath = "", delimiter = ":") {
  const runtimeBin = `${agentHome}/runtime/bin`;
  return currentPath ? `${runtimeBin}${delimiter}${currentPath}` : runtimeBin;
}

export function buildAgentEnv(ambientEnv, config) {
  const merged = { ...ambientEnv, ...config };
  // [task16] Model routing goes exclusively through the ACP model-selection
  // protocol now. ANTHROPIC_MODEL must never reach the sidecar: the launcher
  // unsets it, and bot config must not be able to re-inject it (the old
  // CTI_DEFAULT_MODEL=claude-* injection bypassed the required-default gate).
  delete merged.ANTHROPIC_MODEL;
  // The launcher's fail-closed gate variables are protected fields: bot
  // config must not be able to weaken, widen, or remove the requirement.
  for (const key of [
    "WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL",
    "WEIXIN_AGENT_REQUIRED_DEFAULT_MODEL_DESCRIPTION_PREFIX",
  ]) {
    if (ambientEnv[key] === undefined) delete merged[key];
    else merged[key] = ambientEnv[key];
  }
  return merged;
}
