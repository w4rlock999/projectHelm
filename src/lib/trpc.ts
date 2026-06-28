import { createTRPCReact } from '@trpc/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '#/server/trpc/routers/_app'

// React hooks layer: `trpc.agents.list.useQuery()`, `trpc.agents.create.useMutation()`, etc.
export const trpc = createTRPCReact<AppRouter>()

// Inferred output types — single source of truth for what the client sees.
export type RouterOutputs = inferRouterOutputs<AppRouter>
export type Agent = RouterOutputs['agents']['get']
export type Tool = RouterOutputs['tools']['list'][number]
export type AgentToolView = RouterOutputs['tools']['forAgent'][number]
export type Connection = RouterOutputs['connections']['list'][number]
export type ConnectionChat = RouterOutputs['connections']['chats'][number]
export type Heartbeat = RouterOutputs['heartbeats']['list'][number]
