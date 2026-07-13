// Anthropic API stream events emitted by Claude Code when --include-partial-messages is set.
export type AnthropicStreamEvent =
  | {
      type: 'message_start';
      message: {
        id: string;
        model: string;
        role: 'assistant';
        usage: Record<string, unknown>;
      };
    }
  | {
      type: 'content_block_start';
      index: number;
      content_block:
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown };
    }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string | null; stop_sequence: string | null };
      usage: Record<string, unknown>;
    }
  | { type: 'message_stop' };

// Claude Code's stream-json envelope events.
export type ClaudeEvent =
  | {
      type: 'system';
      subtype: 'init';
      cwd: string;
      session_id: string;
      model: string;
      tools: string[];
      permissionMode: string;
      [k: string]: unknown;
    }
  | {
      type: 'system';
      subtype: 'status';
      status: string;
      session_id: string;
      uuid: string;
    }
  | {
      type: 'rate_limit_event';
      rate_limit_info: Record<string, unknown>;
      session_id: string;
      uuid: string;
    }
  | {
      type: 'stream_event';
      event: AnthropicStreamEvent;
      session_id: string;
      uuid: string;
      parent_tool_use_id?: string | null;
    }
  | {
      type: 'assistant';
      message: {
        role: 'assistant';
        content: unknown[];
        model: string;
        usage: Record<string, unknown>;
      };
      session_id: string;
    }
  | {
      type: 'user';
      message: { role: 'user'; content: unknown[] };
      session_id: string;
    }
  | {
      type: 'result';
      subtype: 'success' | 'error';
      is_error: boolean;
      result: string;
      session_id: string;
      duration_ms: number;
      duration_api_ms?: number;
      num_turns: number;
      total_cost_usd: number;
      usage: Record<string, unknown>;
      stop_reason?: string;
    };

export interface AdapterContext {
  agent: {
    id: string;
    workspaceDir: string;
    claudeSessionId: string | null;
    allowedTools?: string[] | null;
    model?: string | null;
  };
  prompt: string;
  signal: AbortSignal;
  // Extra env for the spawned Claude process — e.g. HELM_CHAT_ID so the
  // send-telegram tool knows which chat to reply to by default.
  env?: Record<string, string>;
  onEvent: (event: ClaudeEvent) => void;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void;
  onSessionId: (sessionId: string) => void;
}

export interface AgentAdapter {
  readonly type: 'claude-code';
  execute(ctx: AdapterContext): Promise<{ code: number | null }>;
}
