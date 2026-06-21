import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { FleetCard } from '#/components/FleetCard'
import { CaptainDock } from '#/components/CaptainDock'
import { CaptainPanel } from '#/components/CaptainPanel'
import { CreateAgentDialog } from '#/components/CreateAgentDialog'
import { SettingsDialog } from '#/components/SettingsDialog'
import { cn } from '#/lib/utils'
import { glass, glassInteractive, monoMeta } from '#/lib/glass'
import { useTheme, type ThemeId } from '#/lib/theme'
import { trpc } from '#/lib/trpc'

type HomeSearch = { chat?: 'captain' }

export const Route = createFileRoute('/')({
  component: Home,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    chat: search.chat === 'captain' ? 'captain' : undefined,
  }),
})

type FleetFilter = 'all' | 'deployed'

function Home() {
  const navigate = useNavigate()
  const { chat } = Route.useSearch()
  const captainOpen = chat === 'captain'
  const { data: agents, error, isLoading } = trpc.agents.list.useQuery()
  const [filter, setFilter] = useState<FleetFilter>('all')
  const [theme, setTheme] = useTheme()

  const visible = (agents ?? []).filter((a) =>
    filter === 'deployed' ? Boolean(a.claudeSessionId) : true,
  )

  return (
    <div className={cn('helm-home', `theme-${theme}`)}>
      {/* Film-grain overlay — painted by the grainy themes (see styles.css). */}
      <div className="helm-grain" aria-hidden />
      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 pb-40 pt-8">
        <Topbar theme={theme} onThemeChange={setTheme} />

        <main className="flex flex-1 flex-col py-10">
          {/* One large glass panel — the "main card". It holds the fleet by
              default, or the helmCaptain chat when ?chat=captain is set. */}
          <section className={cn(glass, 'flex flex-1 flex-col rounded-[2rem] px-7 py-7 sm:px-9 sm:py-8')}>
            {captainOpen ? (
              <CaptainPanel />
            ) : (
              <>
            <div className="flex flex-wrap items-start justify-between gap-5">
              <h1 className="text-3xl font-semibold leading-[1.05] tracking-tight text-[var(--warm-ink)] sm:text-4xl">
                Agents
                <span className="block font-normal text-[var(--warm-ink-soft)]">at your helm</span>
              </h1>

              <FleetTabs filter={filter} onChange={setFilter} />

              <CreateAgentDialog
                onCreated={(a) => navigate({ to: '/agents/$id', params: { id: a.id } })}
                trigger={
                  <button
                    type="button"
                    className={cn(
                      glass,
                      glassInteractive,
                      monoMeta,
                      'rounded-full px-4 py-1.5 text-[0.6rem] text-[var(--warm-ink)]',
                    )}
                  >
                    + new agent
                  </button>
                }
              />
            </div>

            <div className="mt-8">
              {error ? (
                <p className="text-sm text-red-200">{error.message}</p>
              ) : isLoading || !agents ? (
                <p className={cn(monoMeta, 'text-xs text-[var(--warm-ink-faint)]')}>Loading fleet…</p>
              ) : visible.length === 0 ? (
                <div className="flex flex-col items-center rounded-2xl border border-dashed border-white/15 px-10 py-12 text-center">
                  <h2 className="text-lg font-medium text-[var(--warm-ink)]">
                    {filter === 'deployed' ? 'No deployed agents' : 'No agents yet'}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--warm-ink-soft)]">
                    {filter === 'deployed'
                      ? 'Open an agent to start a session and it will appear here.'
                      : 'Create your first wrapped agent to get started.'}
                  </p>
                  {filter === 'all' ? (
                    <div className="mt-5">
                      <CreateAgentDialog
                        onCreated={(a) => navigate({ to: '/agents/$id', params: { id: a.id } })}
                      />
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {visible.map((a) => (
                    <FleetCard key={a.id} agent={a} />
                  ))}
                </div>
              )}
            </div>
              </>
            )}
          </section>
        </main>
      </div>

      {/* helmCaptain dock, pinned bottom-centre. Hidden while the captain
          chat occupies the main card so it never overlaps the composer. */}
      {!captainOpen ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-6">
          <div className="pointer-events-auto w-full max-w-3xl">
            <CaptainDock />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FleetTabs({
  filter,
  onChange,
}: {
  filter: FleetFilter
  onChange: (f: FleetFilter) => void
}) {
  const tabs: FleetFilter[] = ['all', 'deployed']
  return (
    <div className={cn(monoMeta, 'flex items-center gap-5 pt-2 text-[0.7rem]')}>
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          className={cn(
            'lowercase transition-colors',
            filter === t
              ? 'text-[var(--warm-ink)] underline decoration-1 underline-offset-4'
              : 'text-[var(--warm-ink-faint)] hover:text-[var(--warm-ink-soft)]',
          )}
        >
          {t}
        </button>
      ))}
    </div>
  )
}

function Topbar({
  theme,
  onThemeChange,
}: {
  theme: ThemeId
  onThemeChange: (id: ThemeId) => void
}) {
  return (
    <header className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="text-2xl">
          ⎈
        </span>
        <span className="text-2xl font-semibold tracking-tight text-[var(--warm-ink)]">
          HelmConsole
        </span>
      </div>

      <div className="flex items-center gap-4">
        <Link
          to="/tools"
          className={cn(
            monoMeta,
            'text-[0.65rem] text-[var(--warm-ink-soft)] no-underline transition-colors hover:text-[var(--warm-ink)]',
          )}
        >
          Tool Library
        </Link>
        <SettingsDialog theme={theme} onThemeChange={onThemeChange} />
        <Clock />
      </div>
    </header>
  )
}

/** Client-only clock — avoids SSR hydration mismatch. */
function Clock() {
  const [now, setNow] = useState<Date | null>(null)
  useEffect(() => {
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  if (!now) return <div className={cn(monoMeta, 'w-[5.5rem] text-right text-[0.6rem]')} />
  return (
    <div className={cn(monoMeta, 'text-right text-[0.6rem] leading-tight text-[var(--warm-ink-soft)]')}>
      <div>{now.toLocaleTimeString([], { hour12: false })}</div>
      <div className="text-[var(--warm-ink-faint)]">
        {now.toLocaleDateString([], { month: 'short', day: '2-digit', year: 'numeric' })}
      </div>
    </div>
  )
}
