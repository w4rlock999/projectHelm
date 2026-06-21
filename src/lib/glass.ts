/**
 * Shared Tailwind class strings for the warm matte-glass look on the home
 * page. Compose with `cn(...)` so they merge cleanly with shadcn components.
 */
export const glass =
  'bg-white/[0.07] border border-white/15 backdrop-blur-xl ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_24px_60px_rgba(18,9,5,0.34)]'

export const glassInteractive =
  'transition-all duration-200 ease-out hover:bg-white/[0.11] hover:border-white/25 ' +
  'hover:-translate-y-0.5 ' +
  'hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_30px_70px_rgba(18,9,5,0.42)]'

/** Small uppercase mono label used for meta text. */
export const monoMeta = 'font-mono uppercase tracking-[0.12em]'
