import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '#/components/ui/button';
import { Textarea } from '#/components/ui/textarea';
import { cn } from '#/lib/utils';
import { postSSE } from '#/lib/sse';
import type { ClaudeEvent } from '#/server/adapter/types';
import type { Agent } from '#/lib/trpc';
import { MessageBubble, type AssistantSegment, type ChatMessage } from './MessageBubble';

interface Props {
  agent: Agent;
  onSessionAppeared?: () => void;
  /** Tailwind height class for the whole chat column. */
  heightClassName?: string;
  /** `glass` themes the surface for the warm matte-glass home page. */
  variant?: 'default' | 'glass';
}

export function ChatView({
  agent,
  onSessionAppeared,
  heightClassName = 'h-[calc(100vh-12rem)]',
  variant = 'default',
}: Props) {
  const isGlass = variant === 'glass';
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

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

    const userMsg: ChatMessage = { id: crypto.randomUUID(), role: 'user', text };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      segments: [],
      complete: false,
    };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let sessionWasNull = !agent.claudeSessionId;

    try {
      await postSSE({
        url: `/api/agents/${agent.id}/chat`,
        body: { message: text },
        signal: controller.signal,
        onEvent: (name, raw) => {
          if (name !== 'claude') {
            if (name === 'error') {
              setError(safeParse(raw)?.message ?? raw);
            }
            return;
          }
          let evt: ClaudeEvent;
          try {
            evt = JSON.parse(raw) as ClaudeEvent;
          } catch {
            return;
          }
          handleClaudeEvent(evt, assistantMsg.id, setMessages);
          if (sessionWasNull && evt.type === 'system' && evt.subtype === 'init') {
            sessionWasNull = false;
            onSessionAppeared?.();
          }
          if (evt.type === 'result') {
            setMessages((m) =>
              m.map((mm) =>
                mm.id === assistantMsg.id && mm.role === 'assistant'
                  ? { ...mm, complete: true, cost: evt.total_cost_usd, durationMs: evt.duration_ms }
                  : mm,
              ),
            );
          }
        },
      });
    } catch (err) {
      if (controller.signal.aborted) {
        // user-cancelled; mark partial assistant message as complete
        setMessages((m) =>
          m.map((mm) =>
            mm.id === assistantMsg.id && mm.role === 'assistant' ? { ...mm, complete: true } : mm,
          ),
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [agent.id, agent.claudeSessionId, composer, streaming, onSessionAppeared]);

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

  return (
    <div className={cn('flex flex-col', heightClassName)}>
      <div
        className={cn(
          'flex-1 overflow-y-auto border',
          isGlass ? 'rounded-2xl border-white/10 bg-black/15' : 'bg-background/30 rounded-lg',
        )}
      >
        <div className="space-y-4 p-4">
          {messages.length === 0 ? (
            <div
              className={cn(
                'flex flex-col items-center justify-center gap-3 py-16 text-center',
                isGlass ? 'text-[var(--warm-ink-soft)]' : 'text-muted-foreground',
              )}
            >
              <span aria-hidden className={cn('text-3xl', isGlass && 'opacity-70')}>
                ⎈
              </span>
              <p className="text-sm">Send a message to start the conversation.</p>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} variant={variant} />)
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

function safeParse(s: string): { message?: string } | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Returns a dense copy of `arr` with `value` placed at `idx`, padding
// any missing earlier slots with explicit `undefined` so the array is
// never sparse. Sparse arrays break .map() consumers downstream.
function withAt<T>(arr: (T | undefined)[], idx: number, value: T): (T | undefined)[] {
  const out: (T | undefined)[] = arr.slice();
  while (out.length <= idx) out.push(undefined);
  out[idx] = value;
  return out;
}

function handleClaudeEvent(
  evt: ClaudeEvent,
  assistantMsgId: string,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
) {
  if (evt.type !== 'stream_event') return;
  const ev = evt.event;
  if (ev.type === 'content_block_start') {
    const block = ev.content_block;
    setMessages((m) =>
      m.map((mm) => {
        if (mm.id !== assistantMsgId || mm.role !== 'assistant') return mm;
        let next: AssistantSegment | undefined;
        if (block.type === 'text') {
          next = { type: 'text', text: '' };
        } else if (block.type === 'tool_use') {
          next = {
            type: 'tool_use',
            name: block.name,
            id: block.id,
            status: 'running',
            inputJson: '',
          };
        }
        if (!next) return mm;
        return { ...mm, segments: withAt(mm.segments, ev.index, next) };
      }),
    );
  } else if (ev.type === 'content_block_delta') {
    setMessages((m) =>
      m.map((mm) => {
        if (mm.id !== assistantMsgId || mm.role !== 'assistant') return mm;
        const cur = mm.segments[ev.index];
        if (!cur) return mm;
        if (cur.type === 'text' && ev.delta.type === 'text_delta') {
          return {
            ...mm,
            segments: withAt(mm.segments, ev.index, { ...cur, text: cur.text + ev.delta.text }),
          };
        }
        if (cur.type === 'tool_use' && ev.delta.type === 'input_json_delta') {
          return {
            ...mm,
            segments: withAt(mm.segments, ev.index, {
              ...cur,
              inputJson: (cur.inputJson ?? '') + ev.delta.partial_json,
            }),
          };
        }
        return mm;
      }),
    );
  } else if (ev.type === 'content_block_stop') {
    setMessages((m) =>
      m.map((mm) => {
        if (mm.id !== assistantMsgId || mm.role !== 'assistant') return mm;
        const cur = mm.segments[ev.index];
        if (cur?.type === 'tool_use') {
          return {
            ...mm,
            segments: withAt(mm.segments, ev.index, { ...cur, status: 'done' }),
          };
        }
        return mm;
      }),
    );
  }
}
