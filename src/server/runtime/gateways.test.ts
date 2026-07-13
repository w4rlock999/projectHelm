import { describe, expect, it } from 'vitest';
import { SHARED_SESSION_KEY, resolveSessionKey } from './gateways.ts';
import type { GatewayChat } from '../../db/schema.ts';

// resolveSessionKey only reads chat.id, so a minimal stub suffices.
const chat = { id: 'chat-uuid-123' } as GatewayChat;

describe('resolveSessionKey', () => {
  it("returns the chat's stable id under sessionScope='chat' with a chat", () => {
    expect(resolveSessionKey({ sessionScope: 'chat' }, chat)).toBe('chat-uuid-123');
  });

  it("falls back to the shared key under sessionScope='chat' with no chat", () => {
    expect(resolveSessionKey({ sessionScope: 'chat' }, null)).toBe(SHARED_SESSION_KEY);
  });

  it("returns the shared key under sessionScope='agent' regardless of chat", () => {
    expect(resolveSessionKey({ sessionScope: 'agent' }, chat)).toBe(SHARED_SESSION_KEY);
    expect(resolveSessionKey({ sessionScope: 'agent' }, null)).toBe(SHARED_SESSION_KEY);
  });

  it('shared key is the literal "shared"', () => {
    expect(SHARED_SESSION_KEY).toBe('shared');
  });
});
