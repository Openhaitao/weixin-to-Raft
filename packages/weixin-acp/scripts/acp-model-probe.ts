/**
 * Real-handshake model probe for a candidate Claude ACP binary.
 *
 * Spawns the given ACP command, performs initialize + session/new over the
 * real protocol, extracts the model menu with the SAME parser production uses
 * (sessionModelsFromConfigOptions), and asserts the required default model is
 * advertised with the expected description prefix. This is the pre-rollout
 * runtime gate: a mocked test can never prove what the candidate binary
 * actually advertises.
 *
 * Usage:
 *   tsx scripts/acp-model-probe.ts <acp-command> [args...]
 * Env:
 *   PROBE_REQUIRED_MODEL          (default "opus")
 *   PROBE_REQUIRED_DESC_PREFIX   (default "Opus 5")
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AcpConnection } from "../src/acp-connection.js";
import { sessionModelsFromConfigOptions } from "../src/acp-agent.js";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: acp-model-probe <acp-command> [args...]");
  process.exit(2);
}
const requiredModel = process.env.PROBE_REQUIRED_MODEL?.trim() || "opus";
const requiredPrefix =
  process.env.PROBE_REQUIRED_DESC_PREFIX?.trim() || "Opus 5";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "acp-model-probe-"));
const connection = new AcpConnection({ command, args, cwd: scratch });

function fail(msg: string): never {
  console.error(`PROBE FAIL: ${msg}`);
  connection.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}

try {
  const conn = await connection.ensureReady();
  const res = await conn.newSession({ cwd: scratch, mcpServers: [] });
  const models = sessionModelsFromConfigOptions(res);
  if (!models) fail("candidate ACP advertised no model config option");
  console.log(`current: ${models.currentModelId}`);
  for (const m of models.availableModels) {
    console.log(
      `  ${m.modelId === requiredModel ? "->" : "  "} ${m.modelId}`
      + `  name=${JSON.stringify(m.name)}`
      + `  description=${JSON.stringify(m.description ?? "")}`,
    );
  }
  const required = models.availableModels.find(
    (m) => m.modelId === requiredModel,
  );
  if (!required) {
    fail(`required model ${JSON.stringify(requiredModel)} not advertised`);
  }
  if (!required.description?.startsWith(requiredPrefix)) {
    fail(
      `model ${requiredModel} described as `
      + `${JSON.stringify(required.description ?? "(missing)")}; `
      + `expected prefix ${JSON.stringify(requiredPrefix)}`,
    );
  }
  console.log(
    `PROBE PASS: ${requiredModel} advertised with description prefix `
    + `${JSON.stringify(requiredPrefix)}`,
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
} finally {
  connection.dispose();
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(0);
