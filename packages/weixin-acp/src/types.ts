import type { ModelSelectionConfig } from "./model-selection.js";

export type AcpAgentOptions = {
  /** Command to launch the ACP agent, e.g. "npx" */
  command: string;
  /** Command arguments, e.g. ["@agentclientprotocol/codex-acp"] */
  args?: string[];
  /** Extra environment variables for the subprocess */
  env?: Record<string, string>;
  /** Working directory for the subprocess and ACP sessions */
  cwd?: string;
  /** System instructions inserted at the beginning of each new conversation. */
  systemPrompt?: string;
  /** Prompt timeout in milliseconds (default: 120_000) */
  promptTimeoutMs?: number;
  /** Optional bot-local model selection policy and state store. */
  modelSelection?: ModelSelectionConfig | null;
};
