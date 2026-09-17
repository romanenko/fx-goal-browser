import assert from 'node:assert/strict';
import test from 'node:test';
import { JevPolicy, actionSpace, chooseAnswer, type PolicyInput } from '../src/policy.js';
import { FatalError } from '../src/model.js';
import { goal, observation } from './helpers.js';

const input: PolicyInput = { objective: 'Fill Destination with DemoCity, select Design, then search', goal,
  observation: { ...observation(), snapshot: '- textbox "Destination" [ref=e1]\n- button "Search" [ref=e2]\n- combobox "Category" [ref=e3]: All\n  - option "All" [selected, ref=e4]\n  - option "Design" [ref=e5]\n- checkbox "Free cancellation" [checked=false, ref=e6]',
    refs: { e1: { role: 'textbox', name: 'Destination' }, e2: { role: 'button', name: 'Search' }, e3: { role: 'combobox', name: 'Category' }, e4: { role: 'option', name: 'All' }, e5: { role: 'option', name: 'Design' }, e6: { role: 'checkbox', name: 'Free cancellation' } } },
  snapshotHistory: { snapshots: [], visits: [] }, history: [], feedback: null,
};
const signal = new AbortController().signal;
const unusedModel = { async complete() { throw new Error('Ordinary LLM must not choose browser operations or targets'); } };
test('operation-specific choices contain only observed refs and dropdown values', () => {
  const { groups } = actionSpace(input.observation);
  assert.deepEqual(Object.keys(groups.CLICK!), ['e2']);
  assert.deepEqual(Object.keys(groups.TYPE_TEXT!), ['e1']);
  assert.deepEqual(groups.SELECT!.e3_e5!.action, { op: 'select', ref: '@e3', value: 'Design' });
  assert.deepEqual(groups.CHECK!.e6!.action, { op: 'check', ref: '@e6', checked: true });
});
test('stalled actions are excluded while other observed controls stay available', () => {
  const space = actionSpace(input.observation, false, [
    { op: 'scroll', direction: 'down', pixels: 600 },
    { op: 'fill', ref: '@e1', text: 'DemoCity' },
  ]);
  assert.equal('SCROLL_DOWN' in space.operations, false);
  assert.equal('TYPE_TEXT' in space.operations, false);
  assert.ok(space.groups.CLICK?.e2);
  assert.ok(actionSpace(input.observation).operations.SCROLL_DOWN);
});
test('Back is unavailable without an observed prior page and on about:blank; BLOCKED remains available', () => {
  assert.equal('BACK' in actionSpace(input.observation).operations, false);
  assert.equal('BACK' in actionSpace({ ...input.observation, url: 'about:blank' }, true).operations, false);
  assert.equal('BACK' in actionSpace(input.observation, true).operations, true);
  assert.ok(actionSpace(input.observation).operations.BLOCKED);
});
test('Jev selects operation and matching target; unrelated heads never cause actions', async () => {
  const policy = new JevPolicy(unusedModel, async request => {
    assert.equal(request.model, 'typesafe-ai/jev');
    assert.ok(request.questions.goal_state);
    assert.equal('candidateResult' in JSON.parse(request.state), false);
    return { answers: { operation: { type: 'choice', choice: 'CLICK' }, click_target: { type: 'choice', choice: 'e2' },
      type_text_target: { garbage: 'unused' }, goal_state: { type: 'choice', choice: 'incomplete' } } };
  });
  assert.deepEqual((await policy.choose(input, signal)).action, { op: 'click', ref: '@e2' });
});
test('only a Jev-selected editable field invokes the ordinary LLM to write text', async () => {
  let calls = 0;
  const policy = new JevPolicy({ async complete(phase, _prompt, value) {
    calls++; assert.equal(phase, 'text');
    assert.equal((value as { selectedField: { name: string } }).selectedField.name, 'Destination');
    return { text: 'DemoCity' };
  } }, async () => ({ answers: { operation: { type: 'choice', choice: 'TYPE_TEXT' }, type_text_target: { type: 'choice', choice: 'e1' }, goal_state: { type: 'choice', choice: 'incomplete' } } }));
  assert.deepEqual((await policy.choose(input, signal)).action, { op: 'fill', ref: '@e1', text: 'DemoCity' });
  assert.equal(calls, 1);
});
test('DONE only starts extraction after page readiness passes; there is no result in the decision', async () => {
  for (const state of ['incomplete', 'ready']) {
    const policy = new JevPolicy(unusedModel, async () => ({ answers: { operation: { type: 'choice', choice: 'DONE' }, goal_state: { type: 'choice', choice: state } } }));
    const decision = await policy.choose(input, signal);
    assert.equal(decision.action.op, state === 'incomplete' ? 'wait' : 'finish');
    assert.equal('result' in decision.action, false);
  }
});
test('a field writer misunderstanding the task is recoverable and cannot execute an action', async () => {
  const policy = new JevPolicy({ async complete() { return { needsInput: 'The page does not have all final answer fields yet' }; } },
    async () => ({ answers: { operation: { type: 'choice', choice: 'TYPE_TEXT' }, type_text_target: { type: 'choice', choice: 'e1' }, goal_state: { type: 'choice', choice: 'incomplete' } } }));
  await assert.rejects(policy.choose(input, signal), error => error instanceof Error && !(error instanceof FatalError) && error.message.includes('No field value generated'));
});
test('unobserved choices and malformed answers fail without execution', async () => {
  for (const answer of [{ type: 'choice', choice: 'unknown' }, { type: 'choice', choice: 'a', probabilities: { a: NaN } }, { type: 'choice', choice: 'a', probabilities: { a: 0.2, b: 0.8 } }]) assert.throws(() => chooseAnswer(answer, { a: 'A' }));
  const policy = new JevPolicy(unusedModel, async () => ({ answers: { operation: { type: 'choice', choice: 'DONE' } } }));
  await assert.rejects(policy.choose(input, signal));
});

function largePage(count: number): PolicyInput {
  return { ...input, observation: { ...observation(),
    snapshot: Array.from({ length: count }, (_, i) => `- button "Item ${i + 1}" [ref=e${i + 1}]`).join('\n'),
    refs: Object.fromEntries(Array.from({ length: count }, (_, i) => [`e${i + 1}`, { role: 'button', name: `Item ${i + 1}` }])),
  } };
}
test('large pages can finish in one request without submitting oversized unused target heads', async () => {
  let calls = 0;
  const policy = new JevPolicy(unusedModel, async request => {
    calls++;
    for (const question of Object.values(request.questions)) assert.ok(Object.keys(question.criteria).length <= 255);
    assert.equal(request.questions.read_target, undefined);
    assert.equal(request.questions.click_target, undefined);
    const state = JSON.parse(request.state);
    const current = state.snapshotHistory.snapshots.find((snapshot: { id: string }) => snapshot.id === state.currentPage.snapshotId);
    assert.ok(current.text.includes('[ref=e600]'), 'All snapshot evidence is retained');
    return { answers: { operation: { type: 'choice', choice: 'DONE' }, goal_state: { type: 'choice', choice: 'ready' } } };
  });
  assert.equal((await policy.choose(largePage(600), signal)).action.op, 'finish');
  assert.equal(calls, 1);
});
test('255 targets fit one request; larger groups retain targets beyond the first 255', async () => {
  for (const count of [255, 256, 600]) {
    let calls = 0;
    const policy = new JevPolicy(unusedModel, async request => {
      calls++;
      for (const question of Object.values(request.questions)) assert.ok(Object.keys(question.criteria).length <= 255);
      if (request.questions.operation) return { answers: {
        operation: { type: 'choice', choice: 'CLICK' }, goal_state: { type: 'choice', choice: 'incomplete' },
        ...(request.questions.click_target ? { click_target: { type: 'choice', choice: `e${count}` } } : {}),
      } };
      if (request.questions.target_group) {
        const bucket = Object.entries(request.questions.target_group.criteria).find(([, description]) => description.includes(`@e${count} `));
        assert.ok(bucket, 'A later target must remain reachable');
        return { answers: { target_group: { type: 'choice', choice: bucket[0] } } };
      }
      assert.ok(request.questions.target!.criteria[`e${count}`]);
      return { answers: { target: { type: 'choice', choice: `e${count}` } } };
    });
    assert.deepEqual((await policy.choose(largePage(count), signal)).action, { op: 'click', ref: `@e${count}` });
    assert.equal(calls, count <= 255 ? 1 : 3);
  }
});
test('a grouped selection cannot jump to an unoffered reference', async () => {
  let calls = 0;
  const policy = new JevPolicy(unusedModel, async () => {
    calls++;
    if (calls === 1) return { answers: { operation: { type: 'choice', choice: 'CLICK' }, goal_state: { type: 'choice', choice: 'incomplete' } } };
    if (calls === 2) return { answers: { target_group: { type: 'choice', choice: 'group1' } } };
    return { answers: { target: { type: 'choice', choice: 'e300' } } };
  });
  await assert.rejects(policy.choose(largePage(300), signal), /unobserved/);
});
test('permanent Gateway request errors fail clearly instead of reobserving forever', async () => {
  const policy = new JevPolicy(unusedModel, async () => {
    throw Object.assign(new Error('Invalid choice request'), { name: 'GatewayInvalidRequestError', statusCode: 400 });
  });
  await assert.rejects(policy.choose(input, signal), error => error instanceof FatalError && error.message.includes('HTTP 400: Invalid choice request'));
});

test('the complete history includes current evidence once, with no duplicated snapshot or reference table', async () => {
  const page = largePage(300).observation;
  const history = { snapshots: [
    { id: 'earlier', url: page.url, text: 'The first survey question', truncated: false },
    { id: 'current', url: page.url, text: page.snapshot, truncated: false },
  ], visits: [
    { id: 'v1', snapshotId: 'earlier', capturedAt: page.capturedAt },
    { id: page.id, snapshotId: 'current', capturedAt: page.capturedAt },
  ] };
  const policy = new JevPolicy(unusedModel, async request => {
    const state = JSON.parse(request.state);
    assert.deepEqual(state.snapshotHistory, history);
    assert.equal(state.currentPage.snapshotId, 'current');
    assert.equal('snapshot' in state.currentPage, false);
    assert.equal('refs' in state.currentPage, false);
    return { answers: { operation: { type: 'choice', choice: 'DONE' }, goal_state: { type: 'choice', choice: 'ready' } } };
  });
  assert.equal((await policy.choose({ ...input, observation: page, snapshotHistory: history }, signal)).action.op, 'finish');
});
