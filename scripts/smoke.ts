/**
 * End-to-end smoke test of the wrap primitive.
 *
 * Usage:
 *   pnpm tsx scripts/smoke.ts "your message here"
 *
 * Creates (or reuses) a 'Pirate Translator' agent on disk + DB, then runs one
 * turn through runClaude(). Prints token-level text deltas as they arrive and
 * persists raw NDJSON events to .helm/agents/<id>/logs/<runId>.ndjson.
 */
import { createWriteStream, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runClaude } from '../src/server/adapter/claude.ts';
import {
  createAgent,
  listAgents,
  loadAgent,
  updateAgentSessionId,
  agentRuntime,
} from '../src/server/agents.ts';
import { paths } from '../src/server/paths.ts';

const PIRATE_NAME = 'Pirate Translator (smoke)';
const PIRATE_PROMPT = `You translate every reply into pirate-speak. Stay in character at all times. Keep replies short — one or two sentences.`;

function ensurePirateAgent() {
  const existing = listAgents().find((a) => a.name === PIRATE_NAME);
  if (existing) {
    console.log(
      `[smoke] reusing agent ${existing.id} (session=${existing.claudeSessionId ?? 'new'})`,
    );
    return existing;
  }
  const created = createAgent({
    name: PIRATE_NAME,
    systemPrompt: PIRATE_PROMPT,
    allowedTools: null,
    model: 'sonnet',
  });
  console.log(`[smoke] created agent ${created.id}`);
  return created;
}

async function main() {
  const prompt = process.argv.slice(2).join(' ') || 'say hello briefly';
  console.log(`[smoke] prompt: ${prompt}`);

  mkdirSync(paths.helmRoot, { recursive: true });
  const agent = ensurePirateAgent();
  const runtime = agentRuntime(agent);

  const runId = randomUUID();
  const logPath = paths.agentLogFile(agent.id, runId);
  mkdirSync(paths.agentLogsDir(agent.id), { recursive: true });
  const logStream = createWriteStream(logPath, { flags: 'a' });

  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());

  let assistantText = '';
  let lastSessionId: string | null = null;

  const { code } = await runClaude({
    agent: runtime,
    prompt,
    signal: controller.signal,
    onEvent: (evt) => {
      logStream.write(JSON.stringify(evt) + '\n');
      if (evt.type === 'stream_event' && evt.event.type === 'content_block_delta') {
        const delta = evt.event.delta;
        if (delta.type === 'text_delta') {
          process.stdout.write(delta.text);
          assistantText += delta.text;
        }
      } else if (evt.type === 'result') {
        process.stdout.write('\n');
        console.log(`[smoke] done · cost=$${evt.total_cost_usd.toFixed(4)} · ${evt.duration_ms}ms`);
      }
    },
    onLog: () => {
      /* full stdout already covered via onEvent; stderr ignored in smoke */
    },
    onSessionId: (sid) => {
      lastSessionId = sid;
      if (sid !== agent.claudeSessionId) {
        updateAgentSessionId(agent.id, sid);
      }
    },
  });

  logStream.end();

  console.log(`[smoke] exit=${code}`);
  console.log(`[smoke] session_id=${lastSessionId}`);
  console.log(`[smoke] log file: ${logPath}`);

  if (!assistantText.length && code !== 0) {
    console.error('[smoke] no assistant text received — check claude is installed/logged in');
    process.exit(1);
  }

  // Confirm DB picked up the session for next-turn resume.
  const after = loadAgent(agent.id);
  console.log(`[smoke] db session after run: ${after?.claudeSessionId ?? 'null'}`);

  // Verify CLAUDE.md was materialized.
  if (!existsSync(paths.agentClaudeMd(agent.id))) {
    console.error('[smoke] FAIL: CLAUDE.md not found at', paths.agentClaudeMd(agent.id));
    process.exit(1);
  }
  console.log(`[smoke] CLAUDE.md present: ${paths.agentClaudeMd(agent.id)}`);
}

main().catch((err) => {
  console.error('[smoke] error:', err);
  process.exit(1);
});
