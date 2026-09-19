import { Badge } from '#/components/ui/badge';
import { cn } from '#/lib/utils';

export interface TextSegment {
  type: 'text';
  text: string;
}

export interface ToolUseSegment {
  type: 'tool_use';
  name: string;
  id: string;
  status: 'running' | 'done';
  inputJson?: string;
}

export type AssistantSegment = TextSegment | ToolUseSegment;

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string;
      role: 'assistant';
      // May contain undefined holes when Claude emits content blocks at
      // non-contiguous indices; MessageBubble filters them out before render.
      segments: Array<AssistantSegment | undefined>;
      complete: boolean;
      cost?: number;
      durationMs?: number;
      /**
       * Out-of-band notes about the turn itself (e.g. the session expired and
       * it started over). Kept off `segments` deliberately: segments are
       * addressed by content-block index, and a recovered turn restarts its
       * blocks at 0, which would overwrite a notice parked there.
       */
      notices?: string[];
      /** Set when the turn failed. Without it a failure renders as a spinner. */
      error?: string;
    };

export function MessageBubble({
  message,
  variant = 'default',
}: {
  message: ChatMessage;
  variant?: 'default' | 'glass';
}) {
  const isGlass = variant === 'glass';

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[80%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap',
            isGlass ? 'bg-white/15 text-[var(--warm-ink)]' : 'bg-primary text-primary-foreground',
          )}
        >
          {message.text}
        </div>
      </div>
    );
  }

  const visible = message.segments.filter((s): s is AssistantSegment => Boolean(s));
  const hasContent = visible.length > 0;
  const mutedText = isGlass ? 'text-[var(--warm-ink-faint)]' : 'text-muted-foreground';
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          'max-w-[80%] space-y-2 rounded-lg px-4 py-2 text-sm',
          isGlass ? 'border border-white/10 bg-white/[0.06] text-[var(--warm-ink)]' : 'bg-muted',
        )}
      >
        {(message.notices ?? []).map((notice, i) => (
          <p
            key={`notice-${i}`}
            className={cn('text-xs', isGlass ? 'text-amber-200' : 'text-amber-600')}
          >
            {notice}
          </p>
        ))}
        {!hasContent ? (
          // A completed turn with nothing to show is not still thinking — it
          // either failed (the error renders below) or genuinely said nothing.
          message.complete ? (
            message.error ? null : (
              <span className={cn('inline-block', mutedText)}>(no output)</span>
            )
          ) : (
            <span className={cn('inline-block', mutedText)}>
              <span className="inline-block animate-pulse">●</span> thinking…
            </span>
          )
        ) : (
          visible.map((seg, i) => {
            if (seg.type === 'text') {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {seg.text}
                  {!message.complete && i === visible.length - 1 ? (
                    <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
                  ) : null}
                </p>
              );
            }
            return (
              <div key={i}>
                <Badge
                  variant={seg.status === 'done' ? 'secondary' : 'default'}
                  className="gap-1.5"
                >
                  <span className="text-xs">🔧</span>
                  <span>{seg.name}</span>
                  {seg.status === 'running' ? (
                    <span className="text-xs opacity-70">running…</span>
                  ) : null}
                </Badge>
              </div>
            );
          })
        )}
        {message.error ? (
          <p
            className={cn(
              'text-sm whitespace-pre-wrap',
              isGlass ? 'text-red-200' : 'text-destructive',
            )}
          >
            {message.error}
          </p>
        ) : null}
        {message.complete && typeof message.cost === 'number' ? (
          <p
            className={cn(
              'pt-1 text-[10px]',
              isGlass ? 'text-[var(--warm-ink-faint)]' : 'text-muted-foreground/70',
            )}
          >
            ${message.cost.toFixed(4)}
            {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}
