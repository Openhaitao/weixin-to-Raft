export interface RaftMessage {
  target: string;
  messageId: string;
  time: string;
  type: string;
  sender: string;
  text: string;
}

export interface RaftAttachmentRef {
  id: string;
  name: string;
}

const ATTACHMENT_BLOCK = /\s*\[\d+ attachments?:[^\]]*\]/g;
const ATTACHMENT_REF = /([^,]+?) \(id:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g;

/**
 * Split a message's attachment markers (`[1 attachment: name (id:uuid) — use
 * raft attachment view to download]`) from its prose. The marker text is CLI
 * instruction for agents and must never reach a WeChat user; the ids let the
 * bridge download and forward the real files instead.
 */
export function extractAttachments(text: string): { text: string; attachments: RaftAttachmentRef[] } {
  const attachments: RaftAttachmentRef[] = [];
  for (const block of text.match(ATTACHMENT_BLOCK) ?? []) {
    // Parse only the list segment after "N attachments:" so the count prefix
    // can never be mistaken for part of a file name.
    const inner = block.slice(block.indexOf(":") + 1);
    for (const ref of inner.matchAll(ATTACHMENT_REF)) {
      attachments.push({ name: ref[1]!.trim(), id: ref[2]! });
    }
  }
  return { text: text.replace(ATTACHMENT_BLOCK, "").trim(), attachments };
}

const HEADER = /^\[target=(.+?) msg=(\S+) time=(.+?) type=(\S+)\] @([^:]+):(?: (.*))?$/;

export function parseRaftMessages(output: string): RaftMessage[] {
  const messages: RaftMessage[] = [];
  let current: RaftMessage | undefined;

  const finish = () => {
    if (!current) return;
    current.text = current.text.trimEnd();
    messages.push(current);
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(HEADER);
    if (match) {
      finish();
      current = {
        target: match[1]!,
        messageId: match[2]!,
        time: match[3]!,
        type: match[4]!,
        sender: match[5]!,
        text: match[6] ?? "",
      };
      continue;
    }
    if (line === "No new messages." || line === "No more new messages.") {
      finish();
      continue;
    }
    if (current) current.text += `${current.text ? "\n" : ""}${line}`;
  }
  finish();
  return messages;
}

/**
 * A reply may leave Raft for WeChat only when it is an agent's own top-level
 * DM answer: the bridge identity's inbox contains nothing but conversations
 * the bridge itself started, so any such message is a response to a bridged
 * request. Channel traffic, threads, humans, and excluded agents stay in Raft.
 */
export function isAllowedAgentReply(
  message: RaftMessage,
  excludeAgents: readonly string[] = [],
): boolean {
  if (message.type !== "agent") return false;
  if (excludeAgents.some((name) => name.toLowerCase() === message.sender.toLowerCase())) {
    return false;
  }
  return message.target.toLowerCase() === `dm:@${message.sender}`.toLowerCase();
}
