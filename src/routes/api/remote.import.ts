import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFileRoute } from '@tanstack/react-router';
import { deleteAgent, loadAgent } from '../../server/agents.ts';
import { BundleError, CAPS } from '../../server/bundle/format.ts';
import { hashFile } from '../../server/bundle/fs.ts';
import { importAgentBundle } from '../../server/bundle/import.ts';
import { clearImportInFlight, markImportInFlight } from '../../server/bundle/inflight.ts';
import type { ImportResult } from '../../server/bundle/import.ts';
import { harnessDiff, type HarnessFingerprint } from '../../server/harness/fingerprint.ts';
import { deleteMcpServer } from '../../server/library/mcp.ts';
import { deleteLibraryTool } from '../../server/tools.ts';
import { paths } from '../../server/paths.ts';
import { requirePairing } from '../../server/remote-auth.ts';
import { runAgentTurn } from '../../server/run.ts';
import { reconcileGateways } from '../../server/runtime/gateways.ts';
import { ensureRuntimeStarted } from '../../server/runtime/index.ts';
import { BUNDLE_FORMAT_VERSION } from '../../version.ts';
import type { ApiHandlerCtx } from '../../server/api-route.ts';

// /api/remote/import — receive a shipped agent and activate it here.
//
// Body is the raw tarball (application/octet-stream), NOT multipart: there is no
// multipart parser in the dependency tree, and Request.formData() buffers the
// entire body in memory before you can inspect it, which would defeat every size
// cap on a small VPS. Metadata rides in headers so the receiver can reject a
// bundle before reading a byte of it.
//
// Expected failures return HTTP 200 with { ok: false, error, kind } — they are
// status, not errors (the convention set by remotes_.$id.ping.ts). The handler
// SELF-ROLLS-BACK before responding, so `ok: false` guarantees a clean remote,
// which is what lets the shipping side reactivate locally without ambiguity.

export const Route = createFileRoute('/api/remote/import')({
  server: {
    handlers: {
      POST: async ({ request }: ApiHandlerCtx) => {
        const denied = requirePairing(request);
        if (denied) return denied;
        ensureRuntimeStarted();

        const declaredFormat = Number(request.headers.get('x-helm-bundle-format'));
        if (declaredFormat !== BUNDLE_FORMAT_VERSION) {
          return Response.json({
            ok: false,
            kind: 'format',
            error: `bundle format v${declaredFormat || '?'}; this daemon speaks v${BUNDLE_FORMAT_VERSION}`,
          });
        }
        const declaredLength = Number(request.headers.get('content-length'));
        if (declaredLength && declaredLength > CAPS.maxCompressedBytes) {
          return Response.json({
            ok: false,
            kind: 'format',
            error: `bundle is ${declaredLength} bytes, over the transfer cap`,
          });
        }
        if (!request.body) {
          return Response.json({ ok: false, kind: 'format', error: 'empty request body' });
        }

        const transferId = randomUUID();
        const incoming = paths.incomingBundle(transferId);
        mkdirSync(paths.helmRoot + '/tmp/incoming', { recursive: true, mode: 0o700 });

        let importedAgentId: string | null = null;
        let imported: ImportResult | null = null;
        try {
          // Spool to disk rather than memory; the cap is enforced on the real
          // byte count, not on the declared content-length.
          await pipeline(
            Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0]),
            createWriteStream(incoming, { mode: 0o600 }),
          );
          const actual = statSync(incoming).size;
          if (actual > CAPS.maxCompressedBytes) {
            return Response.json({
              ok: false,
              kind: 'format',
              error: `bundle is ${actual} bytes, over the transfer cap`,
            });
          }

          const declaredHash = request.headers.get('x-helm-bundle-sha256');
          if (declaredHash) {
            const actualHash = await hashFile(incoming);
            if (actualHash !== declaredHash) {
              // A truncated transfer is otherwise indistinguishable from a
              // complete one, and this runs before any database work.
              return Response.json({
                ok: false,
                kind: 'io',
                error: 'bundle hash mismatch — the transfer was corrupted or truncated',
              });
            }
          }

          // From here until the smoke turn settles, the agent's status route
          // answers 202: the row may exist, but whether it stays is undecided,
          // and a shipper probing after a lost response must not conclude.
          const claimedAgentId = request.headers.get('x-helm-agent-id');
          if (claimedAgentId) markImportInFlight(claimedAgentId);

          const result = await importAgentBundle(incoming);
          importedAgentId = result.agentId;
          imported = result;
          markImportInFlight(result.agentId);

          // Heartbeats need no activation (the tick re-reads every row), but
          // gateways do — reconcileGateways is only called from mutation sites.
          reconcileGateways();

          // Smoke turn through the real run path, so it proves the harness, the
          // OAuth token, the workspace and the run gate in one shot.
          let smoke: { ok: boolean; runId?: string; text?: string; error?: string };
          let harnessFingerprint: HarnessFingerprint | undefined;
          try {
            const turn = await runAgentTurn(result.agentId, 'ping', { source: 'smoke' });
            harnessFingerprint = turn.harness ?? undefined;
            // A non-zero exit with no result event (a CLI that died parsing its
            // flags) carries isError from run.ts already; the exit code is
            // checked here too so this gate cannot regress to `isError` alone.
            const ok = !turn.isError && (turn.code === 0 || turn.code === null);
            smoke = { ok, runId: turn.runId, text: turn.text.slice(0, 500) };
          } catch (err) {
            smoke = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (!smoke.ok) {
            throw new Error(`imported agent failed its smoke turn: ${smoke.error ?? smoke.text}`);
          }
          // The turn ran, but did the harness load what the bundle declared?
          // A shipped agent silently missing its MCP server is exactly the
          // drift harness ownership exists to stop, so a miss is a refusal.
          const problems = harnessFingerprint
            ? harnessDiff(result.expectedHarness, harnessFingerprint)
            : result.expectedHarness.mcpServers.length > 0
              ? ['the smoke turn produced no harness fingerprint']
              : [];
          if (problems.length > 0) {
            throw new Error(
              `imported agent's harness did not load as declared: ${problems.join('; ')}`,
            );
          }

          return Response.json({
            ok: true,
            agentId: result.agentId,
            imported: result.imported,
            toolsCreated: result.toolsCreated,
            toolsReused: result.toolsReused,
            mcpServersCreated: result.mcpServersCreated,
            mcpServersReused: result.mcpServersReused,
            warnings: result.warnings,
            smoke,
            harnessFingerprint,
          });
        } catch (err) {
          // Self-rollback: leave nothing half-live behind, so `ok: false` is a
          // promise that this daemon is clean.
          if (importedAgentId && loadAgent(importedAgentId)) {
            try {
              deleteAgent(importedAgentId, { force: true });
              reconcileGateways();
            } catch (cleanupErr) {
              console.error('[helm] import rollback failed:', String(cleanupErr));
            }
          }
          // Library rows the import *created* go too (reused ones belong to
          // other agents here). Left behind, a created MCP server is a
          // credential-bearing row a later ship would silently reuse by name.
          for (const t of imported?.toolsCreated ?? []) {
            try {
              deleteLibraryTool(t.id);
            } catch (cleanupErr) {
              console.error('[helm] import rollback: tool', t.name, String(cleanupErr));
            }
          }
          for (const s of imported?.mcpServersCreated ?? []) {
            try {
              deleteMcpServer(s.id);
            } catch (cleanupErr) {
              console.error('[helm] import rollback: mcp server', s.name, String(cleanupErr));
            }
          }
          const kind = err instanceof BundleError ? bundleKind(err) : 'io';
          return Response.json({
            ok: false,
            kind,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          const claimedAgentId = request.headers.get('x-helm-agent-id');
          if (claimedAgentId) clearImportInFlight(claimedAgentId);
          if (importedAgentId) clearImportInFlight(importedAgentId);
          rmSync(incoming, { force: true });
        }
      },
    },
  },
});

/** Map a BundleError to the coarse kind the shipping side switches on. */
function bundleKind(err: BundleError): 'format' | 'version' | 'conflict' | 'requires' | 'io' {
  switch (err.code) {
    case 'unsupported-version':
      return 'version';
    case 'conflict':
    case 'tool-conflict':
    case 'mcp-conflict':
      return 'conflict';
    case 'requires':
      return 'requires';
    case 'malformed':
    case 'unsafe-path':
    case 'integrity':
    case 'too-large':
      return 'format';
    default:
      return 'io';
  }
}
