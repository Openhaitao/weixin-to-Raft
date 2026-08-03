import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { RaftAgentOption } from "./config.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RaftTransport {
  sendToAgent(agent: string, text: string): Promise<{ messageId: string }>;
  checkInbox(): Promise<string>;
  listAgents(): Promise<RaftAgentOption[]>;
  startWakeLoop(onWake: () => void): () => void;
}

export interface RaftCliOptions {
  bin: string;
  profile?: string;
  pollIntervalMs: number;
  drainBeforeRetry?: () => Promise<void>;
}

export class RaftCliTransport implements RaftTransport {
  constructor(private readonly options: RaftCliOptions) {}

  setDrainBeforeRetry(fn: () => Promise<void>): void {
    this.options.drainBeforeRetry = fn;
  }

  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.options.profile ? { RAFT_PROFILE: this.options.profile } : {}),
    };
  }

  private run(args: string[], input?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.bin, args, {
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  async sendToAgent(agent: string, text: string): Promise<{ messageId: string }> {
    const target = `dm:@${agent}`;
    let result = await this.run(["message", "send", "--target", target], `${text}\n`);
    const combined = `${result.stdout}\n${result.stderr}`;
    const accepted = /Message (?:sent|queued).*Message ID:/s.test(combined);
    const draft = /saved as a draft|Draft saved/i.test(combined);
    if (!accepted && draft && this.options.drainBeforeRetry) {
      await this.options.drainBeforeRetry();
      result = await this.run(["message", "send", "--send-draft", "--target", target]);
    }
    const finalOutput = `${result.stdout}\n${result.stderr}`;
    const id = finalOutput.match(/Message ID:\s*([0-9a-f-]+)/i)?.[1];
    if (!id) {
      throw new Error(`Raft message send failed: ${finalOutput.trim().slice(0, 500)}`);
    }
    return { messageId: id };
  }

  async checkInbox(): Promise<string> {
    const result = await this.run(["message", "check"]);
    if (result.code !== 0) {
      throw new Error(`raft message check failed: ${result.stderr.trim().slice(0, 500)}`);
    }
    return result.stdout;
  }

  async listAgents(): Promise<RaftAgentOption[]> {
    const result = await this.run(["server", "info", "--agents", "--limit", "200"]);
    if (result.code !== 0) {
      throw new Error(`raft server info failed: ${result.stderr.trim().slice(0, 500)}`);
    }
    return [...result.stdout.matchAll(/^@([A-Za-z0-9_-]+) \(active;[^)]*\)(?: — (.+))?$/gm)].map(
      (match) => ({
        name: match[1]!,
        ...(match[2]?.trim() ? { description: match[2].trim() } : {}),
      }),
    );
  }

  startWakeLoop(onWake: () => void): () => void {
    let stopped = false;
    let child: ChildProcessWithoutNullStreams | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    const launch = () => {
      if (stopped) return;
      const args = [
        "agent", "bridge", "--json",
        "--poll-interval-ms", String(Math.min(this.options.pollIntervalMs, 10_000)),
      ];
      child = spawn(this.options.bin, args, {
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.end();
      child.stdout.setEncoding("utf-8");
      let buffer = "";
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (line) onWake();
        }
      });
      child.on("error", () => {});
      child.on("close", () => {
        child = undefined;
        if (!stopped) restartTimer = setTimeout(launch, 5_000);
      });
    };
    launch();
    return () => {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill("SIGTERM");
    };
  }
}
