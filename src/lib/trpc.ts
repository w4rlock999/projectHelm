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
export type Gateway = RouterOutputs['gateways']['list'][number]
export type GatewayChat = RouterOutputs['gateways']['chats'][number]
export type Heartbeat = RouterOutputs['heartbeats']['list'][number]
