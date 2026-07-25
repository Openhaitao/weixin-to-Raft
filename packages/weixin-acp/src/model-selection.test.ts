import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createModelSelectionConfig,
  ModelSelectionStore,
  parseModelAllowlist,
} from "./model-selection.js";

const allowlist = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "weixin-model-selection-test-"));

try {
  assert.deepEqual(
    parseModelAllowlist("gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-sol"),
    ["gpt-5.6-sol", "gpt-5.6-terra"],
  );
  assert.throws(() => parseModelAllowlist("../escape"), /invalid model family/);
  assert.equal(createModelSelectionConfig({}), null);
  assert.throws(
    () => createModelSelectionConfig({ WEIXIN_AGENT_MODEL_ALLOWLIST: allowlist.join(",") }),
    /WEIXIN_AGENT_HOME is required/,
  );

  const botA = new ModelSelectionStore(
    path.join(root, "bot-a", "channels", "wechat", "model-selection.json"),
    allowlist,
  );
  const botB = new ModelSelectionStore(
    path.join(root, "bot-b", "channels", "wechat", "model-selection.json"),
    allowlist,
  );

  assert.equal(botA.read(), undefined);
  botA.write("gpt-5.6-terra[high]");
  botB.write("gpt-5.6-luna[medium]");
  assert.equal(botA.read(), "gpt-5.6-terra[high]");
  assert.equal(botB.read(), "gpt-5.6-luna[medium]");
  assert.equal(fs.statSync(botA.filePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(botA.filePath)).mode & 0o077, 0);
  assert.throws(() => botA.write("gpt-5.6-unknown[high]"), /not in the allowlist/);
  assert.throws(() => botA.write("gpt-5.6-sol"), /invalid concrete model id/);

  fs.chmodSync(botA.filePath, 0o644);
  assert.throws(() => botA.read(), /permissions must be 0600/);
  fs.chmodSync(botA.filePath, 0o600);

  fs.writeFileSync(botA.filePath, '{"version":1,"modelId":"../escape"}\n', {
    mode: 0o600,
  });
  assert.throws(() => botA.read(), /state schema is invalid|invalid model id/);

  fs.unlinkSync(botA.filePath);
  fs.symlinkSync(botB.filePath, botA.filePath);
  assert.throws(() => botA.read(), /single regular file/);
  assert.throws(() => botA.write("gpt-5.6-sol[medium]"), /single regular file/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("wechat model selection store tests passed");
