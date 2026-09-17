import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import type { Page } from 'playwright';
import { runAgent } from '../src/agent.js';
import { PlaywrightBrowser, type Observation } from '../src/browser.js';
import type { Action } from '../src/contracts.js';
import { RunStore } from '../src/store.js';
import { GatewayFinalizer } from '../src/finalizer.js';
import { actionSpace } from '../src/policy.js';
import type { Model } from '../src/model.js';
import type { SnapshotHistory } from '../src/store.js';
import { fixtureServer, gatewayResponse, goal, result, tempRun } from './helpers.js';

function ref(o: Observation, role: string, name: string): string {
  const entry = Object.entries(o.refs).find(([, value]) => value.role === role && value.name?.trim() === name);
  assert.ok(entry, `Missing ${role} ${name} in ${o.snapshot}`);
  return `@${entry[0]}`;
}

test('persistent Playwright: refs, literal text, filter submission and final detail', { timeout: 90_000 }, async () => {
  const fixture = await fixtureServer();
  const dir = await tempRun();
  const store = new RunStore(dir);
  const browser = new PlaywrightBrowser();
  let index = 0;
  const steps: ((o: Observation) => Action)[] = [
    o => ({ op: 'fill', ref: ref(o, 'textbox', 'Destination'), text: 'DemoCity' }),
    o => ({ op: 'select', ref: ref(o, 'combobox', 'Category'), value: 'Design' }),
    o => ({ op: 'check', ref: ref(o, 'checkbox', 'Free cancellation'), checked: true }),
    o => ({ op: 'click', ref: ref(o, 'button', 'Search stays') }),
    () => ({ op: 'wait', milliseconds: 200 }),
    o => ({ op: 'click', ref: ref(o, 'button', 'Open Sample Stay') }),
    () => ({ op: 'finish' }),
  ];
  const model: Model = { async complete(phase) {
    assert.equal(phase, 'plan');
    return goal;
  } };
  const finalizer = new GatewayFinalizer({ apiKey: 'test-key', async fetch(_url, init) {
    const body = JSON.parse(String(init?.body));
    const { snapshotHistory, finalVisitId }: { snapshotHistory: SnapshotHistory; finalVisitId: string } =
      JSON.parse(body.prompt.find((message: any) => message.role === 'user').content[0].text);
    const visit = snapshotHistory.visits.find(visit => visit.id === finalVisitId);
    const currentPage = snapshotHistory.snapshots.find(page => page.id === visit?.snapshotId);
    assert.ok(currentPage?.url.endsWith('/stays/sample-stay'));
    assert.ok(currentPage.text.includes('€120 per night'));
    assert.ok(currentPage.text.includes('Applied filters: DemoCity · Design · Free cancellation on'));
    return gatewayResponse({ completion: { status: 'complete', result } });
  } });
  try {
    const actual = await runAgent({ objective: 'Find a Design stay in DemoCity with Free cancellation, open Sample Stay, and return its name, city and price.', url: fixture.url,
      store, browser, signal: new AbortController().signal, retryDelayMs: 0, maxSteps: 12,
      model, finalizer,
      policy: { async choose({ observation }) {
        if (index === 0) {
          const space = actionSpace(observation);
          assert.ok(Object.values(space.groups.SELECT!).some(t => t.action.op === 'select' && t.action.value === 'Design'));
          assert.equal(Object.keys(space.groups.TYPE_TEXT!).length, 1);
        }
        const step = steps[index++];
        assert.ok(step, 'Script exhausted before success');
        return { operation: 'OFFLINE_TEST', ready: true, action: step(observation) };
      } },
    });
    assert.deepEqual(actual, result);
    assert.equal(index, 7);
    const observed = await browser.observe(new AbortController().signal);
    await assert.rejects(browser.act({ op: 'click', ref: '@e999999' }, observed, new AbortController().signal), /current observation/);
    await browser.open(fixture.url, new AbortController().signal);
    const next = await browser.observe(new AbortController().signal);
    const field = ref(next, 'textbox', 'Destination');
    await browser.act({ op: 'fill', ref: field, text: '--help $(echo should-remain-literal)' }, next, new AbortController().signal);
    await assert.rejects(browser.act({ op: 'click', ref: field }, next, new AbortController().signal), /Observe before acting/);
    assert.ok((await browser.observe(new AbortController().signal)).snapshot.includes('--help $(echo should-remain-literal)'));
  } finally {
    await browser.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Simulate external page changes independently of the agent's observed actions.
function ownedPage(browser: PlaywrightBrowser): Page { return Reflect.get(browser, 'page') as Page; }

test('stale node replacement and same-URL reload cannot reuse a decision; the Page persists', { timeout: 30_000 }, async () => {
  const fixture = await fixtureServer();
  const browser = new PlaywrightBrowser(), signal = new AbortController().signal;
  try {
    await browser.open(fixture.url, signal);
    const page = ownedPage(browser);
    let observed = await browser.observe(signal);
    assert.equal(await browser.fresh(observed, signal), true);
    await page.evaluate(() => document.body.classList.add('animation-frame'));
    assert.equal(await browser.fresh(observed, signal), true, 'Nonsemantic DOM changes need no retry');
    await page.getByRole('heading').evaluate(node => { node.textContent = 'A different question'; });
    await assert.rejects(browser.act({ op: 'click', ref: ref(observed, 'button', 'Search stays') }, observed, signal), /Page changed/);
    observed = await browser.observe(signal);
    await page.getByRole('button', { name: 'Search stays' }).evaluate(node => node.replaceWith(node.cloneNode(true)));
    await assert.rejects(browser.act({ op: 'click', ref: ref(observed, 'button', 'Search stays') }, observed, signal), /Page changed/);
    observed = await browser.observe(signal);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assert.rejects(browser.act({ op: 'click', ref: ref(observed, 'button', 'Search stays') }, observed, signal), /Observe before acting/);
    await browser.open(fixture.url, signal);
    assert.equal(ownedPage(browser), page, 'Navigation reuses the same Playwright Page');
  } finally { await browser.close(); await fixture.close(); }
});

test('frame references and native option labels execute against their observed nodes', { timeout: 30_000 }, async () => {
  const fixture = await fixtureServer();
  const browser = new PlaywrightBrowser(), signal = new AbortController().signal;
  try {
    await browser.open(fixture.url, signal);
    const page = ownedPage(browser);
    await page.setContent(`<a href="/details">Read details</a><select aria-label="Category"><option value="all">All</option><option value="design">Design</option></select><iframe srcdoc="<button onclick='this.textContent=&quot;Frame clicked&quot;'>Inside frame</button>"></iframe>`);
    let observed = await browser.observe(signal);
    assert.ok(observed.snapshot.includes('/details'), 'Link destinations remain snapshot evidence');
    const selection = Object.values(actionSpace(observed).groups.SELECT!).find(t => t.action.op === 'select' && t.action.value === 'Design');
    assert.ok(selection, 'Native options without their own refs remain selectable');
    await browser.act(selection.action, observed, signal);
    assert.equal(await page.getByRole('combobox').inputValue(), 'design');
    observed = await browser.observe(signal);
    await browser.act({ op: 'click', ref: ref(observed, 'button', 'Inside frame') }, observed, signal);
    assert.ok((await browser.observe(signal)).snapshot.includes('Frame clicked'));
  } finally { await browser.close(); await fixture.close(); }
});

test('cancellation interrupts a waiting action and closes the owned browser', { timeout: 30_000 }, async () => {
  const fixture = await fixtureServer();
  const browser = new PlaywrightBrowser(), controller = new AbortController();
  try {
    await browser.open(fixture.url, controller.signal);
    const page = ownedPage(browser);
    await page.setContent('<button disabled>Unavailable</button>');
    const observed = await browser.observe(controller.signal);
    const pending = browser.act({ op: 'click', ref: ref(observed, 'button', 'Unavailable') }, observed, controller.signal);
    const timer = setTimeout(() => controller.abort(new Error('Cancelled test action')), 50);
    try { await assert.rejects(pending); } finally { clearTimeout(timer); }
    await browser.close();
    assert.equal(page.isClosed(), true);
    await assert.rejects(browser.observe(new AbortController().signal), /session is closed/);
  } finally { await browser.close(); await fixture.close(); }
});
