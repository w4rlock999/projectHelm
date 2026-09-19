import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db } from './index.ts';

/**
 * Apply any pending drizzle migrations from the checked-in `drizzle/` folder.
 *
 * Called at headless boot only. The local console is migrated by the developer
 * (`pnpm db:migrate`), but a VPS is upgraded with `git pull && pnpm build &&
 * systemctl restart` — and a daemon whose code expects a column its database
 * lacks fails on the very first `select` in the pairing handshake, turning the
 * one status that must never be obscured (ping) into an HTTP 500. Drizzle's
 * migrator is idempotent, so running it on every start is free when there is
 * nothing to do.
 *
 * Resolved against cwd because the daemon roots everything at cwd (`.helm/`,
 * the systemd WorkingDirectory).
 */
export function migrateAtBoot(): { ok: true } | { ok: false; error: string } {
  try {
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'drizzle') });
    return { ok: true };
  } catch (err) {
    // Log and continue rather than crash: under Restart=always a throw here is
    // a crash loop that hides the handshake, whereas a running daemon at least
    // reports its schemaVersion so the operator can see what is wrong.
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[helm] boot migration failed — run \`pnpm db:migrate\` by hand: ${error}`);
    return { ok: false, error };
  }
}
