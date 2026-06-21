import { Link } from '@tanstack/react-router'
import { RotateCcw, Trash2 } from 'lucide-react'
import { Card } from '#/components/ui/card'
import { cn } from '#/lib/utils'
import { glass, glassInteractive, monoMeta } from '#/lib/glass'
import { trpc, type Agent } from '#/lib/trpc'

interface Props {
  agent: Agent
}

/**
 * Glass overview card for a single agent on the warm home page.
 * The whole card links into the agent's chat; reset/delete sit in a
 * quiet footer so the surface stays calm.
 */
export function FleetCard({ agent }: Props) {
  const utils = trpc.useUtils()
  const resetMutation = trpc.agents.resetSession.useMutation({
    onSuccess: () => {
      utils.agents.list.invalidate()
      utils.agents.get.invalidate({ id: agent.id })
    },
  })
  const deleteMutation = trpc.agents.delete.useMutation({
    onSuccess: () => utils.agents.list.invalidate(),
  })

  const active = Boolean(agent.claudeSessionId)

  function onReset(e: React.MouseEvent) {
    e.preventDefault()
    if (!confirm(`Reset conversation for "${agent.name}"? Chat history will be forgotten.`)) return
    resetMutation.mutate({ id: agent.id })
  }

  function onDelete(e: React.MouseEvent) {
    e.preventDefault()
    if (!confirm(`Delete "${agent.name}"? This removes the agent and its workspace on disk.`)) return
    deleteMutation.mutate({ id: agent.id })
  }

  return (
    <Link to="/agents/$id" params={{ id: agent.id }} className="group block h-full no-underline">
      <Card className={cn(glass, glassInteractive, 'flex h-full flex-col gap-0 rounded-2xl py-0 p-5 text-card-foreground')}>
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-[var(--warm-ink)]">{agent.name}</h3>
          <span
            className={cn(
              monoMeta,
              'flex shrink-0 items-center gap-1.5 text-[0.6rem] text-[var(--warm-ink-soft)]',
            )}
            title={active ? `session ${agent.claudeSessionId}` : 'no active session'}
          >
            <span className={cn('size-1.5 rounded-full', active ? 'bg-emerald-300' : 'bg-white/30')} />
            {active ? 'active' : 'idle'}
          </span>
        </div>

        <p className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-[var(--warm-ink-soft)] whitespace-pre-wrap">
          {agent.systemPrompt}
        </p>

        <div className={cn(monoMeta, 'mt-4 text-[0.6rem] text-[var(--warm-ink-faint)]')}>
          {agent.model ?? 'sonnet'} · {new Date(agent.createdAt).toLocaleDateString()}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3">
          <span className="text-sm font-medium text-[var(--warm-ink)] opacity-80 transition-opacity group-hover:opacity-100">
            Open chat →
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onReset}
              disabled={!active || resetMutation.isPending}
              title="Reset session"
              className="rounded-lg p-1.5 text-[var(--warm-ink-soft)] transition-colors hover:bg-white/10 hover:text-[var(--warm-ink)] disabled:opacity-30"
            >
              <RotateCcw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={deleteMutation.isPending}
              title="Delete agent"
              className="rounded-lg p-1.5 text-[var(--warm-ink-soft)] transition-colors hover:bg-red-400/15 hover:text-red-200 disabled:opacity-30"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>
      </Card>
    </Link>
  )
}
