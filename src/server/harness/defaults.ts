import { getSetting, setSetting } from '../settings.ts';
import { EMPTY_PROFILE, HarnessProfileSchema, type HarnessProfile } from './profile.ts';

// Fleet-wide harness defaults: the profile every agent inherits where its own
// is null. One settings row (`harness.defaults`), JSON, memoized by settings.ts.
//
// Changing a default changes the effective profile of every inheriting agent,
// so the caller (system router / REST) follows a write with resyncAllAgents().
// The export side snapshots the *effective* profile into the bundle, so a
// shipped agent pins the default it left with rather than picking up the
// remote's.

export const HARNESS_DEFAULTS_KEY = 'harness.defaults';

export function getHarnessDefaults(): HarnessProfile {
  const raw = getSetting<unknown>(HARNESS_DEFAULTS_KEY, null);
  if (raw === null) return { ...EMPTY_PROFILE };
  const parsed = HarnessProfileSchema.safeParse(raw);
  if (!parsed.success) {
    // A row written by a newer helm with a key this one does not know must
    // not wedge every spawn; fall back to "let the CLI decide" and say so.
    console.error(`[helm] setting ${HARNESS_DEFAULTS_KEY} is not a valid profile — ignoring it`);
    return { ...EMPTY_PROFILE };
  }
  return parsed.data;
}

export function setHarnessDefaults(profile: HarnessProfile): HarnessProfile {
  return setSetting(HARNESS_DEFAULTS_KEY, HarnessProfileSchema.parse(profile));
}
