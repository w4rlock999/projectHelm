/**
 * Minimal SSE client over fetch — supports POST (EventSource is GET-only) and
 * custom event names. Calls onEvent(name, data) for each `event: …\ndata: …`
 * pair; default event name is "message".
 *
 * Returns a promise that resolves when the server closes the stream, or rejects
 * if the connection errors out. Pass an AbortSignal to cancel mid-stream.
 */
export async function postSSE(opts: {
  url: string;
  body: unknown;
  signal: AbortSignal;
  onEvent: (name: string, data: string) => void;
}): Promise<void> {
  const res = await fetch(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`stream failed: ${res.status} ${text}`);
  }
  if (!res.body) {
    throw new Error('stream failed: no response body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, split);
      buf = buf.slice(split + 2);
      if (!block.trim()) continue;
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) eventName = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      opts.onEvent(eventName, dataLines.join('\n'));
    }
  }
}
