export interface RaftMessage {
  target: string;
  messageId: string;
  time: string;
  type: string;
  sender: string;
  text: string;
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
