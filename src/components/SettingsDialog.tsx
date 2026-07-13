import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { cn } from '#/lib/utils';
import { monoMeta } from '#/lib/glass';
import { THEMES, type ThemeId } from '#/lib/theme';

interface Props {
  theme: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  /** Custom trigger element; falls back to a plain "settings" text link. */
  trigger?: React.ReactNode;
}

export function SettingsDialog({ theme, onThemeChange, trigger }: Props) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger ?? (
          <button
            type="button"
            className={cn(
              monoMeta,
              'text-[0.65rem] text-[var(--warm-ink-soft)] transition-colors hover:text-[var(--warm-ink)]',
            )}
          >
            Settings
          </button>
        )}
      </DialogTrigger>
      <DialogContent
        className={cn(
          'rounded-3xl border-white/15 bg-[#1c130f]/90 text-[#fbf0e8] backdrop-blur-2xl sm:max-w-lg',
          'shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_30px_80px_rgba(10,6,4,0.6)]',
          '[&_[data-slot=dialog-close]]:text-[rgba(251,240,232,0.6)] [&_[data-slot=dialog-close]]:hover:opacity-100',
        )}
      >
        <DialogHeader>
          <DialogTitle className="text-[#fbf0e8]">Settings</DialogTitle>
          <DialogDescription className="text-[rgba(251,240,232,0.62)]">
            Personalise your helm. Choose the background that sets the mood.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <p className={cn(monoMeta, 'mb-3 text-[0.6rem] text-[rgba(251,240,232,0.45)]')}>
            Background theme
          </p>
          <div className="grid gap-3">
            {THEMES.map((t) => {
              const active = t.id === theme;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onThemeChange(t.id)}
                  aria-pressed={active}
                  className={cn(
                    'flex items-center gap-4 rounded-2xl border px-3.5 py-3 text-left transition-all',
                    active
                      ? 'border-white/40 bg-white/[0.12]'
                      : 'border-white/10 bg-white/[0.04] hover:border-white/25 hover:bg-white/[0.08]',
                  )}
                >
                  <span
                    aria-hidden
                    className="h-12 w-12 shrink-0 rounded-xl border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
                    style={{ background: t.swatch }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[#fbf0e8]">{t.name}</span>
                    <span className="block text-xs text-[rgba(251,240,232,0.55)]">
                      {t.description}
                    </span>
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded-full border text-[0.55rem] tracking-[0.12em] uppercase transition-opacity',
                      'px-2 py-0.5 font-mono',
                      active
                        ? 'border-white/40 text-[#fbf0e8] opacity-100'
                        : 'border-transparent opacity-0',
                    )}
                  >
                    Active
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
