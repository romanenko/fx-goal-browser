import { setTimeout as delay } from 'node:timers/promises';
import { actionSchema, compileGoal, type Action, type Contract, type JsonObject } from './contracts.js';
import { httpUrl, type Browser, type Observation } from './browser.js';
import { FatalError, type Model } from './model.js';
import type { Finalizer } from './finalizer.js';
import { actionKey, type Policy } from './policy.js';
import { PLAN } from './prompts.js';
import { RunStore } from './store.js';
import { searchWeb, type WebSearch } from './search.js';

export interface AgentOptions {
  objective: string;
  model: Model;
  policy: Policy;
  finalizer: Finalizer;
  browser: Browser;
  store: RunStore;
  signal: AbortSignal;
  url?: string;
  search?: WebSearch;
  maxSteps?: number;
  log?: (message: string) => void;
  retryDelayMs?: number;
  blockedPollMs?: number;
}
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2500); }

export async function runAgent(options: AgentOptions): Promise<JsonObject> {
  const { objective, model, browser, policy, finalizer, store, signal } = options;
  if (!objective.trim()) throw new FatalError('Provide a nonempty objective');
  const log = options.log ?? (() => {});
  let failures = 0;
  async function recover(error: unknown, phase: string): Promise<string> {
    signal.throwIfAborted();
    if (error instanceof FatalError) throw error;
    const detail = message(error);
    log(`${phase}: ${detail}`);
    await store.event('retry', { phase, error: detail });
    await delay(Math.min(10_000, (options.retryDelayMs ?? 500) * 2 ** Math.min(failures++, 5)), undefined, { signal });
    return detail;
  }
  signal.throwIfAborted();
  await store.init();
  await store.save('objective.json', { objective });
  log('Understanding objective and compiling the Zod result parser…');
  let contract: Contract;
  let feedback: unknown = null;
  while (true) {
    signal.throwIfAborted();
    try {
      contract = compileGoal(await model.complete('plan', PLAN, { objective, previousError: feedback }, signal));
      break;
    } catch (error) { feedback = await recover(error, 'Contract rejected'); }
  }
  await store.save('contract.json', contract.goal);
  failures = 0;
  feedback = null;
  log(`Contract locked: ${contract.goal.criteria.length} goal criteria.`);
  const address = objective.match(/https?:\/\/[^\s<>"\x60]+|(?<![\w@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#][^\s<>"\x60]*)?/i)?.[0]?.replace(/[),.;\]]+$/, '');
  const suppliedUrl = address && (/^https?:\/\//i.test(address) ? address : `https://${address}`);
  let startUrl = options.url ?? suppliedUrl;
  while (!startUrl) {
    log('Finding a starting page with Gateway agentic web search…');
    try { startUrl = httpUrl(await (options.search ?? searchWeb)(objective, contract.goal.searchQuery.trim() || objective, signal)); }
    catch (error) { await recover(error, 'Search failed; retrying'); }
  }
  const url = httpUrl(startUrl);
  await store.save('start.json', { url, source: options.url ? 'override' : suppliedUrl ? 'prompt' : 'gateway.parallel_search' });
  // An uncertain navigation is observed, never blindly replayed.
  try { await browser.open(url, signal); }
  catch (error) { feedback = await recover(error, 'Opening page had an uncertain result'); }
  const history: unknown[] = [];
  let actionPage = '';
  const attempts = new Map<string, number>();
  let avoidActions: Action[] = [];
  let step = 0;
  while (true) {
    signal.throwIfAborted();
    if (options.maxSteps !== undefined && step >= options.maxSteps) throw new FatalError(`Explicit step limit ${options.maxSteps} reached without verified success`);
    step++;
    try {
      const observation = await browser.observe(signal);
      await store.observe(observation);
      if (observation.fingerprint !== actionPage) {
        actionPage = observation.fingerprint;
        attempts.clear();
        avoidActions = [];
      }
      log(`[${step}] Observe ${observation.id} · ${observation.url}`);
      const decision = await policy.choose({ objective, goal: contract.goal, observation,
        snapshotHistory: store.snapshotHistory(), history, feedback, avoidActions }, signal);
      const action = actionSchema.parse(decision.action);
      await store.event('decision', { step, observationId: observation.id, ...decision });
      log(`[${step}] Jev ${decision.operation}${'ref' in action ? ` ${action.ref}` : ''} · page ${decision.ready ? 'ready' : 'incomplete'}`);
      const key = actionKey(action);
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
      if (action.op !== 'finish' && action.op !== 'blocked' && attempts.get(key)! >= 3) {
        if (!avoidActions.some(previous => actionKey(previous) === key)) avoidActions.push(action);
        feedback = { stalledAction: action, instruction: 'This action did not change the page. Choose a different observed control or strategy. Answer an unanswered question to enable Next when exploring a multi-step form. Do not treat lack of progress as a human blocker.' };
        await store.event('recovery', { step, observationId: observation.id, feedback });
        log('That action made no progress. Excluding it on this page and choosing another action…');
        continue;
      }
      if (action.op === 'blocked') {
        const reason = 'Jev identified an obstacle requiring human intervention';
        await store.save('blocked.json', { at: new Date().toISOString(), reason, observationId: observation.id, url: observation.url });
        await store.event('blocked', { step, reason, observationId: observation.id });
        log(`${reason}. Waiting for the browser page to change; no AI calls while unchanged. Ctrl+C cancels.`);
        do { await delay(options.blockedPollMs ?? 2000, undefined, { signal }); }
        while (await browser.fresh(observation, signal));
        feedback = { resumed: 'The browser changed after a blocked state. Observe it and choose again.' };
        await store.event('resumed', { step });
        continue;
      }
      if (action.op === 'finish') {
        if (decision.ready !== true) throw new Error('Jev has not confirmed page readiness');
        const current = await browser.observe(signal);
        await store.observe(current);
        if (current.fingerprint !== observation.fingerprint) throw new Error('Page changed after Jev checked readiness; observe and choose again');
        log(`Page ready. Extracting with ${finalizer.model ?? 'Gateway'} structured output…`);
        const snapshotHistory = store.snapshotHistory();
        await store.save('snapshot-history.json', snapshotHistory);
        const completion = await finalizer.extract({ objective, contract, snapshotHistory, finalVisitId: current.id }, signal);
        await store.event('extraction', { step, currentObservationId: current.id, completion });
        if (completion.status === 'complete') {
          const result = completion.result;
          if (!await browser.fresh(current, signal)) throw new Error('Page changed during extraction; completion rejected');
          signal.throwIfAborted();
          await store.save('result.json', result);
          await store.save('verification.json', { verifiedAt: new Date().toISOString(), currentObservationId: current.id,
            pageReadiness: { model: 'typesafe-ai/jev', state: 'ready' },
            extraction: 'AI SDK structured output / ordinary LLM', extractionModel: finalizer.model,
            resultValidation: 'Zod via Output.object', schemaValid: true });
          log('Structured result ready. Returning JSON.');
          return result;
        }
        feedback = { completionRejected: completion.reason };
        log(`More browser evidence needed: ${completion.reason}`);
      } else if (action.op !== 'observe') {
        await store.event('action_started', { step, action, observationId: observation.id });
        try {
          const outcome = await browser.act(action, observation, signal);
          await store.event('action_returned', { step, action, outcome });
          if (action.op === 'read' && outcome && typeof outcome === 'object' && 'observation' in outcome) await store.observe(outcome.observation as Observation);
          feedback = decision.operation === 'DONE' ? { readinessRejected: 'The page is still incomplete; obtain missing evidence before DONE.', outcome } : outcome;
          history.push({ step, operation: decision.operation, ready: decision.ready, action, outcome });
        } catch (error) {
          history.push({ step, action, outcome: 'uncertain_or_rejected', error: message(error) });
          throw error;
        }
      }
      failures = 0;
    } catch (error) {
      feedback = { error: await recover(error, 'Reobserving before the next decision') };
    }
  }
}
