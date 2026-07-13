import { Link } from '@tanstack/react-router';
import { ChevronUp } from 'lucide-react';
import { cn } from '#/lib/utils';
import { glass, glassInteractive, monoMeta } from '#/lib/glass';

/**
 * The helmCaptain capsule pinned to the bottom-centre of the home page.
 * It no longer opens a popover — clicking it routes to `/?chat=captain`,
 * which swaps the main card over to the helmCaptain chat interface. The
 * home page hides this dock while that interface is open (the panel carries
 * its own "back to fleet" control), so it never overlaps the composer.
 */
export function CaptainDock() {
  return (
    <Link
      to="/"
      search={{ chat: 'captain' }}
      className={cn(
        glass,
        glassInteractive,
        'group flex w-full items-center gap-3 rounded-full py-3.5 pr-3 pl-6 text-left no-underline',
      )}
    >
      <span aria-hidden className="text-lg">
        ⎈
      </span>
      <span className="flex flex-1 flex-col leading-tight">
        <span className="text-sm font-medium text-[var(--warm-ink)]">
          Start a chat with helmCaptain
        </span>
        <span className={cn(monoMeta, 'text-[0.55rem] text-[var(--warm-ink-faint)]')}>
          design agents · draft tools · plan orchestration
        </span>
      </span>
      <span className="flex size-8 items-center justify-center rounded-full bg-white/10 text-[var(--warm-ink)] transition-colors group-hover:bg-white/20">
        <ChevronUp className="size-4" />
      </span>
    </Link>
  );
}
