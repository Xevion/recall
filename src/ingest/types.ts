export interface NormalizedSession {
  id: string;
  source: "claude-code" | "opencode" | "cursor" | "other";
  parentId: string | null;
  projectPath: string | null;
  projectName: string | null;
  gitBranch: string | null;
  title: string | null;
  startedAt: Date;
  endedAt: Date | null;
  messageCount: number;
  turnCount: number;
  tokenInput: number;
  tokenOutput: number;
  durationS: number;
  sourcePath: string;
  messages: NormalizedMessage[];
  toolCalls: NormalizedToolCall[];
  subagent: NormalizedSubagent | null;
}

export interface NormalizedMessage {
  id: string;
  sessionId: string;
  role: string;
  model: string | null;
  seq: number;
  timestamp: Date | null;
  tokenInput: number;
  tokenOutput: number;
  content: string | null;
  hasToolUse: boolean;
}

export interface NormalizedToolCall {
  id: string;
  messageId: string;
  sessionId: string;
  toolName: string;
  inputSummary: string | null;
  isError: boolean;
  durationMs: number | null;
}

export interface NormalizedSubagent {
  sessionId: string;
  agentType: string | null;
  slug: string | null;
  prompt: string | null;
  result: string | null;
}
