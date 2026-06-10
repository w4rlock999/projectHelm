import { Badge } from '#/components/ui/badge'

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

export function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm whitespace-pre-wrap">
          {message.text}
        </div>
      </div>
    )
  }

  const visible = message.segments.filter((s): s is AssistantSegment => Boolean(s))
  const hasContent = visible.length > 0
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-lg bg-muted px-4 py-2 text-sm space-y-2">
        {!hasContent ? (
          <span className="text-muted-foreground inline-block">
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
          <p className="text-[10px] text-muted-foreground/70 pt-1">
            ${message.cost.toFixed(4)}
            {message.durationMs ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}
          </p>
        ) : null}
      </div>
    </div>
  )
}
