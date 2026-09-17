import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Goal, JsonObject } from '../src/contracts.js';
import type { Observation } from '../src/browser.js';

export const goal: Goal = {
  summary: 'Find and open Sample Stay with the requested filters.', searchQuery: 'DemoCity Design stay free cancellation',
  resultSchema: {
    type: 'object', additionalProperties: false, required: ['name', 'city', 'price'],
    properties: { name: { type: 'string', minLength: 1 }, city: { type: 'string', enum: ['DemoCity'] }, price: { type: 'number', minimum: 0 } },
  },
  criteria: [
    { id: 'c1', requirement: 'The Sample Stay detail page is open in DemoCity with a price of 120 euros per night.', evidence: 'current_page' },
    { id: 'c2', requirement: 'DemoCity, Design, and Free cancellation filters have been applied.', evidence: 'current_page' },
  ],
};
export const result: JsonObject = { name: 'Sample Stay', city: 'DemoCity', price: 120 };
export function gatewayResponse(value: unknown, finishReason = 'stop'): Response {
  return Response.json({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    finishReason: { unified: finishReason, raw: finishReason },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
    warnings: [],
  });
}
export function observation(id = 'o1'): Observation {
  return { id, url: 'https://example.test/stays/sample-stay', snapshot: 'Sample Stay · DemoCity · Design · Free cancellation · €120 per night',
    refs: {}, fingerprint: 'same', truncated: false, capturedAt: new Date().toISOString() };
}
export async function tempRun() { return mkdtemp(join(tmpdir(), 'fx-goal-browser-test-')); }
export async function fixtureServer() {
  const html = await readFile(new URL('./fixture.html', import.meta.url));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
