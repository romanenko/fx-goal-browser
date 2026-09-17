import { createServer } from 'node:http';
import { once } from 'node:events';
import { PlaywrightBrowser } from '../src/browser.js';

// Measure browser overhead using a synthetic local page, without AI calls.
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Local browser speed fixture</title><main>
    <h1>Survey</h1><h2>Which activities do you enjoy?</h2>
    ${Array.from({ length: 20 }, (_, i) => `<button type="button">Activity ${i + 1}</button>`).join('')}
    <label>Your city <input name="city"></label>
    <p id="count">0 selections</p><script>
    let n = 0;
    document.querySelectorAll('button').forEach(b => b.onclick = () => {
      document.getElementById('count').textContent = (++n) + ' selections';
    });</script></main>`);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No fixture port');
const browser = new PlaywrightBrowser(), signal = AbortSignal.timeout(60_000);
const samples: Record<string, number[]> = {};
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now(), result = await fn();
  (samples[name] ??= []).push(performance.now() - start);
  return result;
}
try {
  await timed('startupOpen', () => browser.open(`http://127.0.0.1:${address.port}`, signal));
  await browser.observe(signal);
  for (let i = 0; i < 12; i++) {
    const observation = await timed('appObserve', () => browser.observe(signal));
    const entry = Object.entries(observation.refs).find(([, r]) => r.role === 'button' && r.name === 'Activity 1');
    if (!entry) throw new Error('Fixture button missing');
    await timed('appFreshCheckAndClick', () => browser.act({ op: 'click', ref: `@${entry[0]}` }, observation, signal));
  }
  const final = await browser.observe(signal);
  if (!final.snapshot.includes('12 selections')) throw new Error('Benchmark clicks did not execute exactly once');
  const metrics = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [name, {
      n: values.length,
      medianMs: +((sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2).toFixed(2),
      minMs: +sorted[0]!.toFixed(2), maxMs: +sorted.at(-1)!.toFixed(2),
      samplesMs: values.map(x => +x.toFixed(2)),
    }];
  }));
  process.stdout.write(JSON.stringify({
    measuredAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, architecture: process.arch, playwright: '1.63.0' },
    method: 'Headless isolated local fixture, 20 buttons and one input; 12 sequential warm samples. No AI calls. Native snapshots, full freshness checks, and real Playwright clicks. Browser startup excludes module imports and is reported separately. This is browser overhead, not an end-to-end agent speedup estimate.',
    verifiedClicks: 12, metrics,
  }, null, 2) + '\n');
} finally {
  try { await browser.close(); }
  finally { server.closeAllConnections(); server.close(); }
}
