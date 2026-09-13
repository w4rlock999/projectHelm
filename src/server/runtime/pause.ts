import { getSetting, setSetting } from '../settings.ts';

// The daemon-wide kill switch.
//
// This exists because an unattended heartbeat agent on a VPS can burn a whole
// Claude subscription overnight, and the per-agent run budget only helps if you
// knew in advance which agent would misbehave. Pause is the blunt instrument
// you reach for at 3am.
//
// It is DB-backed rather than an in-memory flag on purpose: systemd restarts the
// unit on failure, so an in-process flag would silently lift itself during
// exactly the crash-loop it was meant to stop. A switch that turns itself back
// on is not a switch.
//
// Pause stops *new turns* only. Gateway pollers keep draining Telegram so
// messages don't expire server-side and pollOffset keeps advancing; each
// refused message gets a short notice instead of silence.

const KEY = 'daemon.paused';

export interface PauseState {
  paused: boolean;
  /** ISO timestamp of the last transition, or null if never paused. */
  since: string | null;
  reason: string | null;
  /** Who flipped it. 'agent' means an agent's own helm CLI did. */
  by: 'console' | 'api' | 'agent' | null;
}

const UNPAUSED: PauseState = { paused: false, since: null, reason: null, by: null };

export function getPauseState(): PauseState {
  return getSetting<PauseState>(KEY, UNPAUSED);
}

export function isPaused(): boolean {
  return getPauseState().paused;
}

export function setPaused(
  next: boolean,
  opts: { reason?: string | null; by?: PauseState['by'] } = {},
): PauseState {
  const state: PauseState = next
    ? {
        paused: true,
        since: new Date().toISOString(),
        reason: opts.reason?.trim() || null,
        by: opts.by ?? 'api',
      }
    : UNPAUSED;
  return setSetting(KEY, state);
}
