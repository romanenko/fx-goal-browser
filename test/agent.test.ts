import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { RunStore } from '../src/store.js';
import { GatewayFinalizer } from '../src/finalizer.js';
import type { Model } from '../src/model.js';
import type { Browser } from '../src/browser.js';
import { gatewayResponse, goal, result, observation, tempRun } from './helpers.js';

test('loop continues after readiness rejection, invalid extraction, missing evidence and page changes', async () => {
  const dir = await tempRun();
  let decisions = 0, extractions = 0, freshnessChecks = 0, observations = 0;
  const model: Model = { async complete(phase) {
    assert.equal(phase, 'plan');
    return goal;
  } };
  const finalizer = new GatewayFinalizer({ apiKey: 'test-key', async fetch() {
    extractions++;
    if (extractions === 1) return gatewayResponse({ completion: { status: 'complete', result: { ...result, price: '120' } } });
    if (extractions === 2) return gatewayResponse({ completion: { status: 'needs_browser', reason: 'More evidence needed' } });
    return gatewayResponse({ completion: { status: 'complete', result } });
  } });
  const browser: Browser = {
    async open() {}, async close() {}, async act() { throw new Error('No action expected'); },
    async observe() { return observation(`o${++observations}`); },
    async fresh() { return ++freshnessChecks > 1; },
  };
  try {
    const actual = await runAgent({ objective: 'Open Sample Stay', url: 'https://example.test', model, browser, store: new RunStore(dir), signal: new AbortController().signal,
      retryDelayMs: 0, maxSteps: 8, finalizer,
      policy: { async choose() { return { operation: 'DONE', action: { op: 'finish' }, ready: ++decisions > 1 }; } },
    });
    assert.deepEqual(actual, result);
    assert.equal(decisions, 5);
    assert.equal(extractions, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('readiness belongs to the observed page; a page changing before extraction must be judged again', async () => {
  const dir = await tempRun();
  let observations = 0, choices = 0, extractions = 0;
  try {
    await runAgent({ objective: 'Open Sample Stay', url: 'https://example.test', model: { async complete() { return goal; } },
      store: new RunStore(dir), signal: new AbortController().signal, retryDelayMs: 0, maxSteps: 3,
      policy: { async choose() { choices++; return { operation: 'DONE', action: { op: 'finish' }, ready: true }; } },
      finalizer: { async extract() { extractions++; return { status: 'complete', result }; } },
      browser: { async open() {}, async close() {}, async act() {}, async fresh() { return true; },
        async observe() { return { ...observation(`o${++observations}`), fingerprint: observations === 1 ? 'before' : 'after' }; } },
    });
    assert.equal(choices, 2);
    assert.equal(extractions, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('ambiguous browser mutations are never replayed by recovery', async () => {
  const dir = await tempRun();
  let decisions = 0, mutations = 0;
  try {
    await runAgent({ objective: 'Open Sample Stay', url: 'https://example.test', model: { async complete() { return goal; } },
      store: new RunStore(dir), signal: new AbortController().signal, retryDelayMs: 0, maxSteps: 4,
      policy: { async choose() { return { operation: 'TEST', ready: true, action: ++decisions === 1 ? { op: 'click', ref: '@e1' } : { op: 'finish' } }; } },
      finalizer: { async extract() { return { status: 'complete', result }; } },
      browser: { async open() {}, async close() {}, async observe() { return observation(); }, async fresh() { return true; },
        async act() { mutations++; throw new Error('Connection lost after click'); } },
    });
    assert.equal(mutations, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cancellation never reports a successful result', async () => {
  const dir = await tempRun();
  const controller = new AbortController(); controller.abort();
  try {
    await assert.rejects(runAgent({ objective: 'Open Sample Stay', signal: controller.signal, store: new RunStore(dir),
      model: { async complete() { throw new Error('Should not call AI'); } },
      policy: { async choose() { throw new Error('Should not evaluate'); } },
      finalizer: { async extract() { throw new Error('Should not extract'); } }, browser: {} as Browser,
    }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('a blocked browser waits without additional AI calls, then resumes after the page changes', async () => {
  const dir = await tempRun();
  let decisions = 0, polls = 0, observations = 0;
  try {
    const actual = await runAgent({ objective: 'Open Sample Stay', url: 'https://example.test', model: { async complete() { return goal; } },
      store: new RunStore(dir), signal: new AbortController().signal, retryDelayMs: 0, blockedPollMs: 0, maxSteps: 3,
      policy: { async choose() { return { operation: 'TEST', ready: true, action: ++decisions === 1 ? { op: 'blocked' } : { op: 'finish' } }; } },
      finalizer: { async extract() { return { status: 'complete', result }; } },
      browser: { async open() {}, async close() {}, async act() { throw new Error('No mutation expected'); },
        async observe() { return observation(`o${++observations}`); },
        async fresh() { polls++; assert.equal(decisions, polls <= 3 ? 1 : 2); return polls !== 3; },
      },
    });
    assert.deepEqual(actual, result);
    assert.equal(decisions, 2);
    assert.equal(polls, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('stalled scrolling recovers and preserves every question across 15 screens at the same URL', async () => {
  const dir = await tempRun();
  const questions = Array.from({ length: 15 }, (_, i) => `Survey question ${i + 1}?`);
  let screen = 0, decisions = 0, scrolls = 0, recovered = false;
  const surveyGoal = { ...goal, criteria: [{ id: 'c1', requirement: 'All survey questions have been observed.', evidence: 'observed_page' }],
    resultSchema: { type: 'object', properties: { questions: { type: 'array', items: { type: 'string' }, minItems: 15, maxItems: 15 } }, required: ['questions'], additionalProperties: false } };
  try {
    const actual = await runAgent({ objective: 'List all survey questions', url: 'https://example.test/survey',
      model: { async complete() { return surveyGoal; } }, store: new RunStore(dir),
      signal: new AbortController().signal, retryDelayMs: 0, maxSteps: 20,
      policy: { async choose(input) {
        decisions++;
        if (decisions <= 3) return { operation: 'SCROLL_DOWN', ready: false, action: { op: 'scroll', direction: 'down', pixels: 600 } };
        if (decisions === 4) {
          assert.deepEqual(input.avoidActions, [{ op: 'scroll', direction: 'down', pixels: 600 }]);
          assert.ok(input.feedback);
          recovered = true;
        } else assert.deepEqual(input.avoidActions, []);
        if (screen === 14) assert.equal(input.history.length, 16, 'Jev retains the entire action history');
        return { operation: screen === 14 ? 'DONE' : 'CLICK', ready: screen === 14,
          action: screen === 14 ? { op: 'finish' } : { op: 'click', ref: '@e1' } };
      } },
      finalizer: { async extract({ snapshotHistory, finalVisitId }) {
        assert.deepEqual(snapshotHistory.snapshots.map(page => page.text), questions);
        assert.ok(snapshotHistory.visits.length > snapshotHistory.snapshots.length);
        assert.equal(snapshotHistory.visits.at(-1)?.id, finalVisitId);
        return { status: 'complete', result: { questions } };
      } },
      browser: { async open() {}, async close() {}, async fresh() { return true; },
        async observe() { return { ...observation(`o${decisions + 1}`), url: 'https://example.test/survey', snapshot: questions[screen]!, fingerprint: `screen-${screen}` }; },
        async act(action) { if (action.op === 'scroll') scrolls++; else { assert.equal(action.op, 'click'); screen++; } },
      },
    });
    assert.ok(recovered);
    assert.equal(scrolls, 2);
    assert.deepEqual(actual, { questions });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
