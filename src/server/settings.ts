import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { settings } from '../db/schema.ts';

// Daemon-scoped key/value state that must outlive the process but belongs to no
// row. Today one key ('daemon.paused'); this is the home for anything similar.
//
// Values are JSON. Reads are memoized because the pause check runs on the
// admission path of every single turn and must stay pure CPU — the memo is
// invalidated on write, which is safe because a helm daemon is one process per
// database (same reasoning as loadTokenHash's cache in remote-auth.ts).

const cache = new Map<string, unknown>();

export function getSetting<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  let value = fallback;
  if (row) {
    try {
      value = JSON.parse(row.value) as T;
    } catch {
      // A corrupt value must not wedge the daemon; fall back and let the next
      // write repair it.
      console.error(`[helm] setting ${key} is not valid JSON — using the default`);
    }
  }
  cache.set(key, value);
  return value;
}

export function setSetting<T>(key: string, value: T): T {
  const encoded = JSON.stringify(value);
  const now = new Date();
  db.insert(settings)
    .values({ key, value: encoded, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: encoded, updatedAt: now } })
    .run();
  cache.set(key, value);
  return value;
}

/** Test seam: drop the memo so a fresh read hits the database. */
export function clearSettingsCache(): void {
  cache.clear();
}
