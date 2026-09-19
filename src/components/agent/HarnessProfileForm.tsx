import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';

// One form for a harness profile, used both per agent (HarnessPanel) and for
// the fleet defaults (HarnessDefaultsDialog). Every field has an "inherit"
// choice: for an agent that means the fleet default, for the defaults it means
// the CLI's own default — either way no flag is emitted.

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const PERMISSION_MODES = ['default', 'acceptEdits', 'dontAsk'] as const;

export interface ProfileDraft {
  effort: (typeof EFFORTS)[number] | null;
  permissionMode: (typeof PERMISSION_MODES)[number] | null;
  maxTurns: number | null;
  fallbackModel: string | null;
}

export const EMPTY_DRAFT: ProfileDraft = {
  effort: null,
  permissionMode: null,
  maxTurns: null,
  fallbackModel: null,
};

const PERMISSION_HELP: Record<(typeof PERMISSION_MODES)[number], string> = {
  default: 'anything outside the allow-list is denied',
  acceptEdits: 'file edits in the workspace are auto-approved',
  dontAsk: 'never prompt; deny instead',
};

export function HarnessProfileForm({
  value,
  onChange,
  inheritLabel,
  /** The value each field falls back to when set to inherit (shown as a hint). */
  inherited,
  disabled,
}: {
  value: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  inheritLabel: string;
  inherited?: ProfileDraft | null;
  disabled?: boolean;
}) {
  const hint = (k: keyof ProfileDraft) => {
    const v = inherited?.[k];
    return v === null || v === undefined ? 'CLI default' : String(v);
  };
  const select = 'border-input bg-background h-9 w-full rounded-md border px-2 text-sm';

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="hp-effort">Effort</Label>
        <select
          id="hp-effort"
          className={select}
          disabled={disabled}
          value={value.effort ?? ''}
          onChange={(e) =>
            onChange({ ...value, effort: (e.target.value || null) as ProfileDraft['effort'] })
          }
        >
          <option value="">
            {inheritLabel} ({hint('effort')})
          </option>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="hp-mode">Permission mode</Label>
        <select
          id="hp-mode"
          className={select}
          disabled={disabled}
          value={value.permissionMode ?? ''}
          onChange={(e) =>
            onChange({
              ...value,
              permissionMode: (e.target.value || null) as ProfileDraft['permissionMode'],
            })
          }
        >
          <option value="">
            {inheritLabel} ({hint('permissionMode')})
          </option>
          {PERMISSION_MODES.map((x) => (
            <option key={x} value={x}>
              {x} — {PERMISSION_HELP[x]}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="hp-turns">Max turns per run</Label>
        <Input
          id="hp-turns"
          type="number"
          min={1}
          max={10_000}
          disabled={disabled}
          placeholder={`${inheritLabel} (${hint('maxTurns')})`}
          value={value.maxTurns ?? ''}
          onChange={(e) =>
            onChange({ ...value, maxTurns: e.target.value === '' ? null : Number(e.target.value) })
          }
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="hp-fallback">Fallback model</Label>
        <Input
          id="hp-fallback"
          disabled={disabled}
          placeholder={`${inheritLabel} (${hint('fallbackModel')})`}
          value={value.fallbackModel ?? ''}
          onChange={(e) => onChange({ ...value, fallbackModel: e.target.value.trim() || null })}
        />
        <p className="text-muted-foreground text-xs">
          Used when the primary model is overloaded. Must differ from the agent's model.
        </p>
      </div>
    </div>
  );
}
