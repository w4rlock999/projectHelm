import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '#/components/ui/button';
import { Textarea } from '#/components/ui/textarea';
import { cn } from '#/lib/utils';
import { postSSE } from '#/lib/sse';
import {
  applyEvent,
  createTurnBuilder,
  finishTurn,
  messageIds,
  type AssistantMessage,
  type LedgerOutcome,
  type LoggedLine,
} from '#/lib/chat-replay';
import { trpc, type Agent, type HistoryTurn } from '#/lib/trpc';
import { MessageBubble, SessionDivider, type ChatMessage } from './MessageBubble';

interface Props {
  agent: Agent;
  onSessionAppeared?: () => void;
  /** Tailwind height class for the whole chat column. */
  heightClassName?: string;
  /** `glass` themes the surface for the warm matte-glass home page. */
  variant?: 'default' | 'glass';
}

/** Turns per history page. A page is one ledger query plus one log read per turn. */
const PAGE = 50;

/**
 * The turn currently streaming. Finished turns are not kept here: the history
 * query is the record, and once it contains this turn's runId the live copy
 * is dropped. Both sides use `messageIds(runId)`, so React sees the same keys
 * and the hand-over is a prop update, not a remount.
 */
interface LiveTurn {
  /** Null until the SSE `open` event names the run. */
  runId: string | null;
  sessionId: string | null;
  user: Extract<ChatMessage, { role: 'user' }>;
  assistant: AssistantMessage;
}

/** What the list renders: history turns, then the live one. */
interface VisibleTurn {
  key: string;
  sessionId: string | null;
  messages: ChatMessage[];
}

export function ChatView({
  agent,
  onSessionAppeared,
  heightClassName = 'h-[calc(100vh-12rem)]',
  variant = 'default',
}: Props) {
  const isGlass = variant === 'glass';
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
  const [composer, setComposer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  const utils = trpc.useUtils();
  // Pages run newest-first: page 0 is the latest PAGE turns, each further page
  // is older. An invalidate refetches every page with fresh cursors, so a new
  // turn shifts the window without opening a gap between pages.
  const history = trpc.agents.history.useInfiniteQuery(
    { id: agent.id, limit: PAGE },
    {
      getNextPageParam: (last) => (last.hasMore ? last.turns[0]?.startedAt : undefined),
      // A heartbeat or Telegram turn may be mid-flight while the page is open;
      // its bubble says "thinking…" and this is what resolves it.
      refetchInterval: (query) =>
        query.state.data?.pages.some((p) =>
          p.turns.some((t) => t.status === 'queued' || t.status === 'running'),
        )
          ? 3000
          : false,
    },
  );

  const historyTurns = useMemo<HistoryTurn[]>(() => {
    const pages = history.data?.pages ?? [];
    // Oldest page first, each page already oldest-first.
    return pages
      .slice()
      .reverse()
      .flatMap((p) => p.turns);
  }, [history.data]);

  // Hand-over: once history has caught up with the turn we streamed, drop the
  // local copy. Identical ids on both sides make this invisible.
  useEffect(() => {
    if (streaming || !liveTurn?.runId) return;
    if (historyTurns.some((t) => t.runId === liveTurn.runId)) setLiveTurn(null);
  }, [streaming, liveTurn, historyTurns]);

  const visibleTurns = useMemo<VisibleTurn[]>(() => {
    const out: VisibleTurn[] = historyTurns
      .filter((t) => t.runId !== liveTurn?.runId)
      .map((t) => ({ key: t.runId, sessionId: t.sessionId, messages: t.messages }));
    if (liveTurn) {
      out.push({
        key: liveTurn.runId ?? 'live',
        sessionId: liveTurn.sessionId,
        messages: [liveTurn.user, liveTurn.assistant],
      });
    }
    return out;
  }, [historyTurns, liveTurn]);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [visibleTurns]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const send = useCallback(async () => {
    const text = composer.trim();
    if (!text || streaming) return;
    setComposer('');
    setError(null);

    // Every event — live here, replayed after a refresh — goes through the same
    // reducer, so what streams in is what history will show.
    const builder = createTurnBuilder();
    const pendingIds = messageIds(`pending-${crypto.randomUUID()}`);
    setLiveTurn({
      runId: null,
      sessionId: null,
      user: { id: pendingIds.user, role: 'user', text },
      assistant: { id: pendingIds.assistant, role: 'assistant', segments: [], complete: false },
    });
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let sessionWasNull = !agent.claudeSessionId;
    let closed = false;

    const patchAssistant = (fields: Partial<AssistantMessage>) =>
      setLiveTurn((t) => (t ? { ...t, assistant: { ...t.assistant, ...fields } } : t));
    const syncFromBuilder = () =>
      setLiveTurn((t) =>
        t
          ? {
              ...t,
              sessionId: builder.sessionId,
              assistant: {
                ...t.assistant,
                segments: [...builder.segments],
                ...(builder.notices.length ? { notices: [...builder.notices] } : {}),
              },
            }
          : t,
      );
    // Exactly one close per turn. `result`, `end`, `error` and abort can all
    // arrive for the same turn; the first to get here decides.
    const close = (outcome: LedgerOutcome) => {
      if (closed) return;
      closed = true;
      patchAssistant(finishTurn(builder, outcome));
    };

    try {
      await postSSE({
        url: `/api/agents/${agent.id}/chat`,
        body: { message: text },
        signal: controller.signal,
        onEvent: (name, raw) => {
          if (name === 'open') {
            const runId = safeParse(raw)?.runId;
            if (typeof runId === 'string') {
              // Re-key to the run's ids while the bubble is still empty, so the
              // remount is invisible and history can take over by the same key.
              const ids = messageIds(runId);
              setLiveTurn((t) =>
                t
                  ? {
                      ...t,
                      runId,
                      user: { ...t.user, id: ids.user },
                      assistant: { ...t.assistant, id: ids.assistant },
                    }
                  : t,
              );
            }
            return;
          }
          if (name === 'error') {
            // e.g. a budget refusal. Previously only the banner was set and the
            // bubble stayed on "thinking…" forever — no `end` follows an error.
            const message = safeParse(raw)?.message ?? raw;
            setError(message);
            close({ status: 'error', exitCode: null, resultText: message });
            return;
          }
          if (name === 'end') {
            const code = safeParse(raw)?.code;
            close({
              status: 'ok',
              exitCode: typeof code === 'number' ? code : null,
              resultText: null,
            });
            return;
          }
          if (name !== 'claude') return;

          let evt: LoggedLine;
          try {
            evt = JSON.parse(raw) as LoggedLine;
          } catch {
            return;
          }
          const changed = applyEvent(builder, evt);
          if (evt.type === 'system' && evt.subtype === 'init') {
            if (sessionWasNull) {
              sessionWasNull = false;
              onSessionAppeared?.();
            }
            // The session id is what places the divider, so push it even
            // though nothing in the bubble changed.
            syncFromBuilder();
            return;
          }
          if (evt.type === 'helm_notice' && evt.notice === 'session_reset') {
            onSessionAppeared?.();
          }
          if (evt.type === 'result') {
            // finishTurn reads the result off the builder; the outcome is moot.
            close({ status: 'ok', exitCode: null, resultText: null });
            return;
          }
          if (changed) syncFromBuilder();
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        close({ status: 'interrupted', exitCode: null, resultText: null });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        close({ status: 'error', exitCode: null, resultText: message });
      }
    } finally {
      // A stream that closed without `end` or `result` (the CLI crashing, say)
      // still has to settle the bubble.
      close({ status: 'ok', exitCode: null, resultText: null });
      setStreaming(false);
      abortRef.current = null;
      // The ledger and log are complete once the stream closes (run.ts awaits
      // the log flush before the route sends `end`), so history can take over.
      utils.agents.history.invalidate({ id: agent.id });
    }
  }, [agent.id, agent.claudeSessionId, composer, streaming, onSessionAppeared, utils]);

  function cancel() {
    abortRef.current?.abort();
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const glassButton =
    'border border-white/20 bg-white/10 text-[var(--warm-ink)] shadow-none hover:bg-white/20';
  const mutedText = isGlass ? 'text-[var(--warm-ink-soft)]' : 'text-muted-foreground';
  const showEmpty = history.isSuccess && visibleTurns.length === 0;

  return (
    <div className={cn('flex flex-col', heightClassName)}>
      <div
        className={cn(
          'flex-1 overflow-y-auto border',
          isGlass ? 'rounded-2xl border-white/10 bg-black/15' : 'bg-background/30 rounded-lg',
        )}
      >
        <div className="space-y-4 p-4">
          {history.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                disabled={history.isFetchingNextPage}
                onClick={() => history.fetchNextPage()}
                className={cn(
                  'text-xs',
                  isGlass && 'text-[var(--warm-ink-soft)] hover:bg-white/10',
                )}
              >
                {history.isFetchingNextPage ? 'Loading…' : 'Load earlier turns'}
              </Button>
            </div>
          ) : null}
          {history.isLoading ? (
            <p className={cn('py-16 text-center text-sm', mutedText)}>Loading history…</p>
          ) : history.isError ? (
            <p
              className={cn(
                'py-4 text-center text-sm',
                isGlass ? 'text-red-200' : 'text-destructive',
              )}
            >
              Could not load the conversation: {history.error.message}
            </p>
          ) : showEmpty ? (
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-3 py-16 text-center',
                mutedText,
              )}
            >
              <span aria-hidden className={cn('text-3xl', isGlass && 'opacity-70')}>
                ⎈
              </span>
              <p className="text-sm">Send a message to start the conversation.</p>
            </div>
          ) : (
            renderTurns(visibleTurns, variant)
          )}
          <div ref={scrollEndRef} />
        </div>
      </div>

      {error ? (
        <p className={cn('mt-2 text-sm', isGlass ? 'text-red-200' : 'text-destructive')}>{error}</p>
      ) : null}

      <div className="mt-3 flex items-end gap-2">
        <Textarea
          value={composer}
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            streaming
              ? 'Streaming response…'
              : 'Type a message — Enter to send, Shift+Enter for newline.'
          }
          rows={2}
          disabled={streaming}
          className={cn(
            'resize-none',
            isGlass &&
              'border-white/15 bg-white/5 text-[var(--warm-ink)] placeholder:text-[var(--warm-ink-faint)] focus-visible:border-white/30 focus-visible:ring-white/10',
          )}
        />
        {streaming ? (
          <Button variant="outline" onClick={cancel} className={cn(isGlass && glassButton)}>
            Stop
          </Button>
        ) : (
          <Button onClick={send} disabled={!composer.trim()} className={cn(isGlass && glassButton)}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Bubbles in order, with a divider wherever the Claude session id changes.
 * Turns whose log never named a session (missing log, died before init)
 * neither draw a divider nor move the baseline — they are not evidence of a
 * reset, only of a turn that said nothing.
 */
function renderTurns(turns: VisibleTurn[], variant: 'default' | 'glass') {
  const nodes: React.ReactNode[] = [];
  let lastSession: string | null = null;
  for (const turn of turns) {
    if (turn.sessionId && lastSession && turn.sessionId !== lastSession) {
      nodes.push(<SessionDivider key={`divider-${turn.key}`} variant={variant} />);
    }
    if (turn.sessionId) lastSession = turn.sessionId;
    for (const m of turn.messages) {
      nodes.push(<MessageBubble key={m.id} message={m} variant={variant} />);
    }
  }
  return nodes;
}

function safeParse(s: string): { message?: string; code?: number; runId?: string } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
