import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Credential-free local stub of the Chat Completions subset used by the live
 * adapter. Behaviors are selected by the model name so tests can exercise
 * malformed responses, streaming, partial streams and cancellation without a
 * provider. This is a test double, not a model.
 */
export type StubBehavior =
  | 'tool-then-answer'
  | 'stream-tool-then-answer'
  | 'malformed-json'
  | 'bad-tool-args'
  | 'truncated-stream'
  | 'slow'
  | 'http-500'
  | 'blocked-tool';

export interface StubServer {
  url: string;
  requests: Array<{ body: any; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

const ANSWER = JSON.stringify({ claims: [{ text: 'Cells retained 80% capacity after 1,200 cycles.', cites: ['snap-01'] }] });

function sse(res: http.ServerResponse, chunks: unknown[], done = true) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}

export async function startStub(): Promise<StubServer> {
  const requests: StubServer['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body: any = {};
      try { body = JSON.parse(raw); } catch { /* recorded below */ }
      requests.push({ body, headers: req.headers });
      if (req.url !== '/v1/chat/completions' && req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
      const behavior = String(body.model ?? '') as StubBehavior;
      const hadTool = (body.messages ?? []).some((m: any) => m.role === 'tool');
      const toolCall = (name: string, args: string) => ({ id: `call_${requests.length}`, type: 'function', function: { name, arguments: args } });
      switch (behavior) {
        case 'http-500':
          res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"stub failure"}');
          return;
        case 'malformed-json':
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"choices": [ this is not json');
          return;
        case 'slow':
          setTimeout(() => { if (!res.writableEnded) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'late' }, finish_reason: 'stop' }] })); }, 5000);
          return;
        case 'truncated-stream':
          sse(res, [{ choices: [{ delta: { content: 'Partial ans' } }] }], false);
          return;
        case 'bad-tool-args':
          if (!hadTool) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall('sources__retrieve', '{"question": ')] }, finish_reason: 'tool_calls' }] })); return; }
          break;
        case 'blocked-tool':
          if (!hadTool) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall('email__send', '{"to":"x@example.test","body":"hi"}')] }, finish_reason: 'tool_calls' }] })); return; }
          break;
        case 'stream-tool-then-answer':
          if (!hadTool) {
            sse(res, [
              { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: 'sources__retrieve', arguments: '' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"question":"How did the pilot ' } }] } }] },
              { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'storage site perform?"}' } }] }, finish_reason: 'tool_calls' }] },
            ]);
          } else {
            const half = Math.floor(ANSWER.length / 2);
            sse(res, [{ choices: [{ delta: { content: ANSWER.slice(0, half) } }] }, { choices: [{ delta: { content: ANSWER.slice(half) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }]);
          }
          return;
        default:
          break;
      }
      // tool-then-answer (also the second turn of bad-tool-args and blocked-tool)
      if (!hadTool) {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [toolCall('sources__retrieve', JSON.stringify({ question: 'How did the pilot storage site perform?' }))] }, finish_reason: 'tool_calls' }] }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 30 } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
