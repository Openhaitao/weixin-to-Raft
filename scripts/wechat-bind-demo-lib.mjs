export function resolveStartArgs(rest, cwd, systemPromptFile) {
  const ddIndex = rest.indexOf("--");
  const common = [
    "start",
    "--cwd", cwd,
    "--system-prompt-file", systemPromptFile,
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
  delete merged.ANTHROPIC_MODEL;
  const model = config.CTI_DEFAULT_MODEL?.trim();
  if (model && /^claude(?:-|$)/i.test(model)) {
    merged.ANTHROPIC_MODEL = model;
  }
  return merged;
}
