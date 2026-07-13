/**
 * End-to-end verification — drives the live HTTP API (not the React UI).
 *
 * Prerequisite: dev server already running on http://localhost:3000
 *   pnpm dev
 *
 * Then in a separate terminal:
 *   pnpm tsx scripts/e2e.ts
 *
 * CRUD goes through the typed tRPC client (proves the AppRouter inference
 * works for non-browser consumers too). Streaming chat goes through raw
 * fetch + SSE (proves the hybrid is real — the chat route is intentionally
 * not a tRPC subscription).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { paths } from '../src/server/paths.ts';
import type { AppRouter } from '../src/server/trpc/routers/_app.ts';

const BASE = process.env.HELM_BASE ?? 'http://localhost:3000';
const J = { 'content-type': 'application/json' };

const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: `${BASE}/api/trpc` })],
});

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function consumeSSE(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<{
  events: Array<{ name: string; data: unknown }>;
  assistantText: string;
  sessionId?: string;
  cost?: number;
}> {
  const res = await fetch(url, {
    method: 'POST',
    headers: J,
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events: Array<{ name: string; data: unknown }> = [];
  let assistantText = '';
  let sessionId: string | undefined;
  let cost: number | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!block.trim()) continue;
      let name = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) name = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      let data: any;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      events.push({ name, data });
      if (name === 'claude') {
        if (data.type === 'system' && data.subtype === 'init') sessionId = data.session_id;
        else if (
          data.type === 'stream_event' &&
          data.event?.type === 'content_block_delta' &&
          data.event?.delta?.type === 'text_delta'
        ) {
          assistantText += data.event.delta.text as string;
        } else if (data.type === 'result') {
          cost = data.total_cost_usd;
        }
      }
    }
  }
  return { events, assistantText, sessionId, cost };
}

async function main() {
  console.log(`E2E target: ${BASE}\n`);

  // 1. Health: tRPC list query responds.
  const initialList = await trpc.agents.list.query();
  assert(
    Array.isArray(initialList),
    `tRPC agents.list returns an array (got ${initialList.length} agents)`,
  );

  // 2. Clean slate: remove any prior E2E pirate via tRPC delete.
  for (const a of initialList) {
    if (a.name === 'E2E Pirate Translator') {
      await trpc.agents.delete.mutate({ id: a.id });
    }
  }

  // 3. Create the pirate agent via tRPC.
  const agent = await trpc.agents.create.mutate({
    name: 'E2E Pirate Translator',
    systemPrompt:
      'You translate every reply into pirate-speak. Stay in character at all times. Keep replies to one or two sentences.',
  });
  assert(typeof agent.id === 'string', `tRPC agents.create returned an Agent`);
  console.log(`  → id=${agent.id}\n`);

  // 4. On-disk: CLAUDE.md materialized.
  const claudeMdPath = paths.agentClaudeMd(agent.id);
  assert(existsSync(claudeMdPath), `CLAUDE.md exists at ${claudeMdPath}`);
  const claudeMdContent = readFileSync(claudeMdPath, 'utf8');
  assert(claudeMdContent.includes('pirate-speak'), `CLAUDE.md contents reflect the system prompt`);

  // 5. First chat turn (SSE, NOT tRPC).
  console.log('Turn 1: "How is the weather today?"');
  const turn1 = await consumeSSE(`${BASE}/api/agents/${agent.id}/chat`, {
    message: 'How is the weather today?',
  });
  console.log(`  text: ${turn1.assistantText}`);
  console.log(`  cost: $${turn1.cost?.toFixed(4) ?? '?'}\n`);
  assert(turn1.assistantText.length > 0, 'Turn 1 streamed assistant text via SSE');
  assert(
    /matey|arrr|ahoy|ye|pirate|ye'|harr/i.test(turn1.assistantText),
    'Turn 1 response is pirate-speak (steering applied via CLAUDE.md)',
  );
  assert(turn1.sessionId !== undefined, 'Turn 1 received a session_id from init event');

  // 6. Session captured in DB — read via tRPC get.
  const detail1 = await trpc.agents.get.query({ id: agent.id });
  assert(detail1.claudeSessionId === turn1.sessionId, 'Session_id persisted to DB after turn 1');

  // 7. NDJSON log file written.
  const logsDir = paths.agentLogsDir(agent.id);
  const fs = await import('node:fs/promises');
  const logFiles = await fs.readdir(logsDir);
  assert(logFiles.length >= 1, 'NDJSON log file written for turn 1');
  const log1Path = `${logsDir}/${logFiles[0]}`;
  const log1Stats = statSync(log1Path);
  assert(log1Stats.size > 100, `NDJSON log has content (${log1Stats.size} bytes)`);

  // 8. Second turn — proves --resume works.
  console.log('Turn 2: "What did I just ask you?"');
  const turn2 = await consumeSSE(`${BASE}/api/agents/${agent.id}/chat`, {
    message: 'What did I just ask you?',
  });
  console.log(`  text: ${turn2.assistantText}\n`);
  assert(turn2.assistantText.length > 0, 'Turn 2 streamed assistant text');
  assert(
    /weather/i.test(turn2.assistantText),
    'Turn 2 references "weather" — proves --resume continuity works',
  );
  assert(
    /matey|arrr|ahoy|ye|pirate|ye'|harr/i.test(turn2.assistantText),
    'Turn 2 still pirate-speak — proves CLAUDE.md steering persists across resume',
  );
  assert(turn2.sessionId === turn1.sessionId, 'Turn 2 reuses the same session_id');

  // 9. Reset session via tRPC mutation.
  const reset = await trpc.agents.resetSession.mutate({ id: agent.id });
  assert(reset.claudeSessionId === null, 'tRPC resetSession clears session in DB');

  // 10. Client-disconnect cleanup: abort mid-stream and check no orphan claude.
  console.log('Turn 3: starting then aborting mid-stream…');
  const abortCtl = new AbortController();
  setTimeout(() => abortCtl.abort(), 600); // abort ~600ms in
  let aborted = false;
  try {
    await consumeSSE(
      `${BASE}/api/agents/${agent.id}/chat`,
      { message: 'Count to fifty slowly please.' },
      abortCtl.signal,
    );
  } catch (err) {
    aborted = err instanceof DOMException && err.name === 'AbortError';
  }
  assert(aborted, 'Mid-stream abort raised AbortError on the client');
  await new Promise((r) => setTimeout(r, 1500));
  const psBuf = await (
    await import('node:child_process')
  ).execSync("ps aux | grep -E 'claude --print|claude -p' | grep -v grep | wc -l", {
    encoding: 'utf8',
  });
  const claudeProcs = parseInt(psBuf.trim(), 10);
  assert(
    claudeProcs === 0,
    `No orphan claude processes after client disconnect (${claudeProcs} found)`,
  );

  // Cleanup via tRPC.
  await trpc.agents.delete.mutate({ id: agent.id });

  console.log('\n🎉 All checks passed (tRPC CRUD + SSE chat hybrid).');
}

main().catch((err) => {
  console.error('\n✗ E2E error:', err);
  process.exit(1);
});
