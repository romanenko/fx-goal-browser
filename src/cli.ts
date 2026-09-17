#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runAgent } from './agent.js';
import { PlaywrightBrowser } from './browser.js';
import { DEFAULT_EXTRACTION_MODEL, GatewayFinalizer } from './finalizer.js';
import { JevPolicy } from './policy.js';
import { FxModel } from './model.js';
import { RunStore } from './store.js';
import { searchWeb } from './search.js';

const help = `Usage: fx-goal-browser [options] "objective"
       printf '%s' "objective" | fx-goal-browser

Options:
  --url URL            Starting URL (otherwise detect an address, or use Gateway search)
  --headed             Show the browser window
  --model ID           Planning/search/field-value model (default openai/gpt-5.4-mini)
  --extract-model ID   Final extraction model (default ${DEFAULT_EXTRACTION_MODEL})
  --max-steps NUMBER   Optional explicit decision limit; absent means unlimited
  --run-dir DIRECTORY  Parent directory for run artifacts (default ./runs)
  --help               Show this help

Reads AI_GATEWAY_API_KEY from the environment or .env in the current directory.
All AI calls use Vercel AI Gateway. Jev drives the browser and checks page readiness.
An ordinary LLM extracts final JSON using the goal's Zod schema in one structured call.
Success: exactly one result JSON on stdout, exit 0. Progress goes to stderr.
Cancellation/fatal error: one error JSON on stdout, nonzero exit. Ctrl+C cancels.
`;

const controller = new AbortController();
const interrupt = () => controller.abort(new Error('Cancelled by user'));
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
let browser: PlaywrightBrowser | undefined;
let store: RunStore | undefined;
function progress(text: string): void {
  process.stderr.write(text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 3000) + '\n');
}
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' }, headed: { type: 'boolean' }, url: { type: 'string' },
      model: { type: 'string' },
      'extract-model': { type: 'string' },
      'max-steps': { type: 'string' }, 'run-dir': { type: 'string' },
    },
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    let objective = positionals.join(' ').trim();
    if (!objective && !process.stdin.isTTY) {
      for await (const chunk of process.stdin) {
        objective += String(chunk);
        if (objective.length > 20_000) throw new Error('Objective exceeds 20,000 characters');
      }
      objective = objective.trim();
    }
    if (!objective || objective.length > 20_000) throw new Error('Supply an objective of 1–20,000 characters. Use --help for examples.');
    const maxSteps = values['max-steps'] === undefined ? undefined : Number(values['max-steps']);
    if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) throw new Error('--max-steps must be a positive integer');
    const modelOptions = { apiKey: process.env.AI_GATEWAY_API_KEY ?? '', model: values.model ?? process.env.FX_MODEL ?? 'openai/gpt-5.4-mini' };
    const model = new FxModel(modelOptions);
    const policy = new JevPolicy(model);
    const finalizer = new GatewayFinalizer({ apiKey: modelOptions.apiKey,
      model: values['extract-model'] ?? process.env.FX_EXTRACT_MODEL ?? DEFAULT_EXTRACTION_MODEL });
    const runDir = resolve(values['run-dir'] ?? 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
    store = new RunStore(runDir);
    browser = new PlaywrightBrowser({ headed: values.headed });
    progress(`Run artifacts: ${runDir}`);
    const result = await runAgent({ objective, model, policy, finalizer, browser, store,
      search: (objective, query, signal) => searchWeb(objective, query, signal, modelOptions),
      signal: controller.signal, url: values.url, maxSteps, log: progress });
    process.stdout.write(JSON.stringify(result) + '\n');
  }
} catch (error) {
  const cancelled = controller.signal.aborted;
  const raw = cancelled ? 'Cancelled before verified completion' : error instanceof Error ? error.message : String(error);
  const key = process.env.AI_GATEWAY_API_KEY;
  const message = key ? raw.replaceAll(key, '[REDACTED]') : raw;
  const failure = { error: { code: cancelled ? 'CANCELLED' : 'RUN_FAILED', message } };
  await store?.save('error.json', failure).catch(() => {});
  process.stdout.write(JSON.stringify(failure) + '\n');
  process.exitCode = cancelled ? 130 : 1;
} finally {
  await browser?.close().catch(() => progress('Could not close the browser session automatically.'));
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
