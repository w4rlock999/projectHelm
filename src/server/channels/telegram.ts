/**
 * Thin Telegram Bot API client over `fetch` — no SDK. Covers just what the v0
 * channel needs: validate a token, long-poll for updates, send a message.
 *
 * Docs: https://core.telegram.org/bots/api
 */

const API = 'https://api.telegram.org'

interface TgResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function call<T>(
  token: string,
  method: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  })
  const data = (await res.json()) as TgResponse<T>
  if (!data.ok || data.result === undefined) {
    throw new Error(data.description ?? `telegram ${method} failed (${res.status})`)
  }
  return data.result
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

/** Validate a bot token; returns the bot's identity. */
export function getMe(token: string): Promise<TelegramUser> {
  return call<TelegramUser>(token, 'getMe')
}

export interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: TelegramUser
    chat: { id: number; type: string; title?: string; username?: string }
    text?: string
    date: number
  }
}

/**
 * Long-poll for updates starting at `offset`. `timeout` is the server-side hold
 * (seconds); the fetch is also abortable for clean shutdown.
 */
export function getUpdates(
  token: string,
  offset: number,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<TelegramUpdate[]> {
  return call<TelegramUpdate[]>(
    token,
    'getUpdates',
    { offset, timeout: opts.timeout ?? 30, allowed_updates: ['message'] },
    opts.signal,
  )
}

export function sendMessage(token: string, chatId: string | number, text: string): Promise<unknown> {
  return call(token, 'sendMessage', { chat_id: chatId, text })
}
