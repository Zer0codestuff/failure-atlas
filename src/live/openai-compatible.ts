/**
 * OpenAI-compatible Chat Completions adapter (explicit subset, Node only).
 *
 * Supported request features: model, messages (system, user, assistant with
 * tool_calls, tool), tools of type "function" with JSON Schema parameters,
 * tool_choice "auto", temperature, stream true or false.
 * Supported response features: choices[0].message.content,
 * choices[0].message.tool_calls (function), finish_reason, usage.
 * Streaming: server-sent events with choices[0].delta.content and
 * choices[0].delta.tool_calls fragments merged by index, terminated by
 * "data: [DONE]". A stream that ends without [DONE] is reported as partial.
 * Cancellation: an AbortSignal aborts the HTTP request; the adapter reports
 * "cancelled" and never retries on its own.
 *
 * Not supported: multiple choices (n > 1), audio, images, logprobs, the
 * Responses API, provider-specific extensions, parallel_tool_calls control.
 * "OpenAI-compatible" endpoints differ; this adapter is only validated
 * against the local stub in src/live/stub-server.ts. Live provider
 * validation is pending.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  stream?: boolean;
}

export type ChatOutcome =
  | { kind: 'ok'; content: string | null; toolCalls: ToolCall[]; finishReason: string | null; usage: unknown; chunks: number; raw: unknown }
  | { kind: 'malformed'; message: string; raw: string }
  | { kind: 'http-error'; status: number; body: string }
  | { kind: 'partial'; message: string; content: string | null; toolCalls: ToolCall[]; chunks: number }
  | { kind: 'cancelled'; message: string }
  | { kind: 'network-error'; message: string };

export interface AdapterConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
}

/** Read configuration from the runner environment. Credentials never enter bundles or the browser. */
export function configFromEnv(env: Record<string, string | undefined> = process.env): AdapterConfig | null {
  const baseUrl = env.FA_LIVE_BASE_URL;
  const model = env.FA_LIVE_MODEL;
  if (!baseUrl || !model) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey: env.FA_LIVE_API_KEY, model, timeoutMs: env.FA_LIVE_TIMEOUT_MS ? Number(env.FA_LIVE_TIMEOUT_MS) : 60_000 };
}

function validToolCalls(calls: unknown): calls is ToolCall[] {
  return Array.isArray(calls) && calls.every((c) => c && typeof c.id === 'string' && c.function && typeof c.function.name === 'string' && typeof c.function.arguments === 'string');
}

export async function chatCompletion(cfg: AdapterConfig, req: ChatRequest, signal?: AbortSignal, onChunk?: (delta: unknown) => void): Promise<ChatOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), cfg.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort(new Error('cancelled'));
  signal?.addEventListener('abort', onAbort);
  try {
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ ...req, model: cfg.model, tool_choice: req.tools?.length ? 'auto' : undefined }),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'cancelled', message: signal?.aborted ? 'Cancelled by the caller' : 'Timed out' };
      return { kind: 'network-error', message: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) return { kind: 'http-error', status: res.status, body: (await res.text()).slice(0, 2000) };
    if (!req.stream) {
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        return { kind: 'malformed', message: 'Response body is not JSON', raw: text.slice(0, 2000) };
      }
      const msg = json?.choices?.[0]?.message;
      if (!msg) return { kind: 'malformed', message: 'Response has no choices[0].message', raw: text.slice(0, 2000) };
      const calls = msg.tool_calls ?? [];
      if (!validToolCalls(calls)) return { kind: 'malformed', message: 'tool_calls entries lack id, function.name or string function.arguments', raw: text.slice(0, 2000) };
      return { kind: 'ok', content: msg.content ?? null, toolCalls: calls, finishReason: json.choices[0].finish_reason ?? null, usage: json.usage ?? null, chunks: 0, raw: json };
    }
    // Streaming (SSE).
    const reader = res.body?.getReader();
    if (!reader) return { kind: 'malformed', message: 'Streaming response has no body', raw: '' };
    const decoder = new TextDecoder();
    let buffer = '';
    let content: string | null = null;
    const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    let finish: string | null = null;
    let usage: unknown = null;
    let chunks = 0;
    let done = false;
    try {
      while (!done) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') { done = true; break; }
          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            return { kind: 'malformed', message: `Stream chunk ${chunks + 1} is not JSON`, raw: payload.slice(0, 500) };
          }
          chunks++;
          const delta = chunk?.choices?.[0]?.delta ?? {};
          onChunk?.(delta);
          if (typeof delta.content === 'string') content = (content ?? '') + delta.content;
          for (const tc of delta.tool_calls ?? []) {
            const i = typeof tc.index === 'number' ? tc.index : calls.length;
            calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) calls[i].id = tc.id;
            if (tc.function?.name) calls[i].function.name += tc.function.name;
            if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
          }
          if (chunk?.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
          if (chunk?.usage) usage = chunk.usage;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return { kind: 'cancelled', message: signal?.aborted ? 'Cancelled by the caller during streaming' : 'Timed out during streaming' };
      return { kind: 'partial', message: `Stream failed: ${err instanceof Error ? err.message : String(err)}`, content, toolCalls: calls.filter(Boolean), chunks };
    }
    if (!done) return { kind: 'partial', message: 'Stream ended without [DONE]', content, toolCalls: calls.filter(Boolean), chunks };
    const merged = calls.filter(Boolean);
    if (!validToolCalls(merged) || merged.some((c) => !c.id || !c.function.name)) return { kind: 'malformed', message: 'Streamed tool call is missing id or name', raw: JSON.stringify(merged).slice(0, 500) };
    return { kind: 'ok', content, toolCalls: merged, finishReason: finish, usage, chunks, raw: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
