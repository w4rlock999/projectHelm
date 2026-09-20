import { describe, expect, it } from 'vitest';
import { RemoteAgentStatusSchema } from './transfer.ts';

// The status route is read by a newer local side from an older daemon; the
// schema must accept the M2 shape (no lastHarness) and keep unknown fields.
describe('RemoteAgentStatusSchema', () => {
  it('parses an M2-shaped status without lastHarness', () => {
    const parsed = RemoteAgentStatusSchema.parse({
      ok: true,
      paused: false,
      agent: { id: 'a', name: 'n', model: null, deployState: 'deployed' },
      heartbeats: [],
      runs: [],
    });
    expect(parsed.lastHarness).toBeUndefined();
    expect((parsed as Record<string, unknown>).heartbeats).toEqual([]);
  });

  it('parses a fingerprint when present, and null', () => {
    expect(RemoteAgentStatusSchema.parse({ ok: true, lastHarness: null }).lastHarness).toBeNull();
    const fp = {
      claudeVersion: '2.1.278',
      model: null,
      permissionMode: null,
      tools: [],
      skills: [],
      plugins: [],
      mcpServers: [],
      agents: [],
      slashCommands: [],
      capturedAt: 1,
    };
    expect(
      RemoteAgentStatusSchema.parse({ ok: true, lastHarness: fp }).lastHarness?.claudeVersion,
    ).toBe('2.1.278');
  });
});
