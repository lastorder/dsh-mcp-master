#!/usr/bin/env node
// Minimal stdio MCP server used by the tests (newline-delimited JSON-RPC).
import { createInterface } from 'node:readline';

let tools = [
  {
    name: 'echo',
    description: 'Echo the text back',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to echo', minLength: 1 },
        times: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], default: null },
        mode: { $ref: '#/$defs/Mode' },
      },
      required: ['text'],
      $defs: { Mode: { type: 'string', enum: ['plain', 'loud'] } },
    },
    annotations: { readOnlyHint: true },
  },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
  { name: 'grow', description: 'Adds a tool and notifies list_changed', inputSchema: { type: 'object' } },
];

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let pingAnswered = false;

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === 'srv-ping') { pingAnswered = 'result' in msg; return; }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1.2.3' }, instructions: 'fixture server' } });
    return;
  }
  if (msg.method === 'notifications/initialized') {
    // Server-initiated request: the client must answer.
    send({ id: 'srv-ping', method: 'ping' });
    return;
  }
  if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools } });
    return;
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'echo') {
      const text = args.mode === 'loud' ? String(args.text).toUpperCase() : String(args.text);
      send({ id: msg.id, result: { content: [{ type: 'text', text: Array(args.times ?? 1).fill(text).join(' ') }], structuredContent: { pingAnswered, cwd: process.cwd(), token: process.env.FIXTURE_TOKEN ?? '' } } });
    } else if (name === 'fail') {
      send({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: 'it failed on purpose' }] } });
    } else if (name === 'grow') {
      tools = [...tools, { name: 'extra', description: 'Added later', inputSchema: { type: 'object' } }];
      send({ id: msg.id, result: { content: [{ type: 'text', text: 'grown' }] } });
      send({ method: 'notifications/tools/list_changed' });
    } else {
      send({ id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } });
    }
    return;
  }
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'method not found' } });
});
