/**
 * Re-materialize tools + re-render CLAUDE.md for every agent. Run after changing
 * renderClaudeMd / materializeAgentTools so existing agents pick up the new
 * managed tools block without needing a tool/gateway mutation to trigger a sync.
 */
import { resyncAllAgents } from '../src/server/tools.ts';

console.log(`resynced ${resyncAllAgents()} agent(s)`);
