import { Badge } from '#/components/ui/badge'
import { cn } from '#/lib/utils'

export interface TextSegment {
  type: 'text'
  text: string
}

export interface ToolUseSegment {
  type: 'tool_use'
  name: string
  id: string
  status: 'running' | 'done'
  inputJson?: string
}

export type AssistantSegment = TextSegment | ToolUseSegment

export type ChatMessage =
  | { id: string; role: 'user'; text: string }
  | {
      id: string
      role: 'assistant'
      // May contain undefined holes when Claude emits content blocks at
      // non-contiguous indices; MessageBubble filters them out before render.
      segments: Array<AssistantSegment | undefined>
      complete: boolean
      cost?: number
      durationMs?: number
    }

export function MessageBubble({
  message,
  variant = 'default',
}: {
  message: ChatMessage
  variant?: 'default' | 'glass'
}) {
  const isGlass = variant === 'glass'

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
    )
  }

  const visible = message.segments.filter((s): s is AssistantSegment => Boolean(s))
  const hasContent = visible.length > 0
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          'max-w-[80%] rounded-lg px-4 py-2 text-sm space-y-2',
          isGlass ? 'border border-white/10 bg-white/[0.06] text-[var(--warm-ink)]' : 'bg-muted',
        )}
      >
        {!hasContent ? (
          <span
            className={cn(
              'inline-block',
              isGlass ? 'text-[var(--warm-ink-faint)]' : 'text-muted-foreground',
            )}
          >
            <span className="inline-block animate-pulse">●</span> thinking…
          </span>
        ) : (
          visible.map((seg, i) => {
            if (seg.type === 'text') {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {seg.text}
                  {!message.complete && i === visible.length - 1 ? (
                    <span className="inline-block w-1.5 h-3 bg-current ml-0.5 animate-pulse align-middle" />
                  ) : null}
                </p>
              )
            }
            return (
              <div key={i}>
                <Badge variant={seg.status === 'done' ? 'secondary' : 'default'} className="gap-1.5">
                  <span className="text-xs">🔧</span>
                  <span>{seg.name}</span>
                  {seg.status === 'running' ? (
                    <span className="text-xs opacity-70">running…</span>
                  ) : null}
                </Badge>
              </div>
            )
          })
        )}
        {message.complete && typeof message.cost === 'number' ? (
          <p
            className={cn(
              'text-[10px] pt-1',
              isGlass ? 'text-[var(--warm-ink-faint)]' : 'text-muted-foreground/70',
            )}
          >
            ${message.cost.toFixed(4)}
            {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}
          </p>
        ) : null}
      </div>
    </div>
  )
}
