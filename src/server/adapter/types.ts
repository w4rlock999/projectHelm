import type { HarnessArgv } from '../harness/profile.ts';

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
      // Present from claude 2.1.x; optional because the harness fingerprint
      // (src/server/harness/fingerprint.ts) must degrade, not fail, on an
      // older CLI. `plugins[].path` is a host-local detail and is dropped there.
      claude_code_version?: string;
      skills?: string[];
      plugins?: { name: string; path?: string; source?: string }[];
      mcp_servers?: { name: string; status: string }[];
      agents?: string[];
      slash_commands?: string[];
      memory_paths?: Record<string, string>;
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
  | ClaudeResultEvent
  | HelmNoticeEvent;

/**
 * The end-of-turn envelope. Split out of the union because the recovery path
 * passes one around (see `onSessionInvalid`).
 *
 * `result` and `usage` are optional because a turn that dies before it starts
 * omits them entirely — a pruned `--resume` session produces exactly one event,
 * `error_during_execution` with `num_turns: 0`, and states the reason only in
 * `errors`. Typing `result` as required is what let that failure read as an
 * empty string in the run ledger.
 */
export interface ClaudeResultEvent {
  type: 'result';
  subtype: 'success' | 'error' | 'error_during_execution' | 'error_max_turns';
  is_error: boolean;
  result?: string;
  /** Present on failures; often the only statement of what went wrong. */
  errors?: string[];
  result_index?: number;
  session_id: string;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  total_cost_usd: number;
  usage?: Record<string, unknown>;
  stop_reason?: string;
}

/**
 * Helm's own event, injected into the stream rather than emitted by the CLI.
 *
 * It rides the same channel as every other event so it needs no plumbing of its
 * own: `run.ts` writes it to the run's ndjson, the SSE route forwards it as
 * `event: claude`, and the chat UI renders it. Headless callers ignore it.
 */
export interface HelmNoticeEvent {
  type: 'helm_notice';
  notice: 'session_reset';
  text: string;
  /** The session id that turned out to be gone. */
  session_id?: string;
}

export interface AdapterContext {
  agent: {
    id: string;
    workspaceDir: string;
    claudeSessionId: string | null;
    allowedTools?: string[] | null;
    model?: string | null;
    /**
     * The rendered harness (isolation flags + profile). Optional only so the
     * adapter's unit tests can build a context without a filesystem;
     * production (`agentRuntime`) always supplies it, and without it the
     * spawn inherits the host's ~/.claude — the exact thing H1 removes.
     */
    harness?: HarnessArgv;
  };
  prompt: string;
  signal: AbortSignal;
  // Extra env for the spawned Claude process — e.g. HELM_CHAT_ID so the
  // send-telegram tool knows which chat to reply to by default.
  env?: Record<string, string>;
  onEvent: (event: ClaudeEvent) => void;
  onLog: (stream: 'stdout' | 'stderr', chunk: string) => void;
  onSessionId: (sessionId: string) => void;
  /**
   * Fired when a `--resume` attempt died solely because the stored session no
   * longer exists on disk. The failure `result` was withheld from `onEvent` —
   * forwarding it would mark the chat bubble complete at $0.0000 before the
   * retry streams in — and is handed over here so the caller can log it and
   * forget the dead id. A retry without `--resume` follows immediately.
   *
   * Required rather than optional on purpose: it is the only thing that clears
   * the dead id, and an optional callback would let a future caller silently
   * reintroduce the permanent brick this exists to fix.
   */
  onSessionInvalid: (info: { staleSessionId: string; result: ClaudeResultEvent }) => void;
}

export interface AgentAdapter {
  readonly type: 'claude-code';
  execute(ctx: AdapterContext): Promise<{ code: number | null }>;
}
