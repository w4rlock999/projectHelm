import { reconcileConnections } from './connections.ts'
import { startHeartbeatScheduler } from './heartbeats.ts'

/**
 * Boot the background daemon loops (heartbeat scheduler + Telegram pollers)
 * exactly once per server process. Idempotent and HMR-safe via a globalThis
 * flag. Called from the tRPC context factory and the agent-facing REST routes,
 * so the loops come up as soon as the server handles any request.
 */
export function ensureRuntimeStarted(): void {
  if ((globalThis as any).__helmRuntimeStarted) return
  ;(globalThis as any).__helmRuntimeStarted = true
  try {
    startHeartbeatScheduler()
    reconcileConnections()
    console.log('[helm] runtime started (heartbeat scheduler + connection pollers)')
  } catch (err) {
    // Don't wedge request handling if boot hiccups; next request retries.
    ;(globalThis as any).__helmRuntimeStarted = false
    console.error('[helm] runtime start failed:', String(err))
  }
}
