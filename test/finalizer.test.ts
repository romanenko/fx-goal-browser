import assert from 'node:assert/strict';
import test from 'node:test';
import { compileGoal } from '../src/contracts.js';
import { DEFAULT_EXTRACTION_MODEL, GatewayFinalizer } from '../src/finalizer.js';
import { FatalError } from '../src/model.js';
import { gatewayResponse, goal, result, observation } from './helpers.js';

const page = observation('o1');
const input = { objective: 'Open Sample Stay and return the requested fields', contract: compileGoal(goal),
  snapshotHistory: {
    snapshots: [{ id: page.id, url: page.url, text: page.snapshot, truncated: false }],
    visits: [{ id: 'o1', snapshotId: 'o1', capturedAt: page.capturedAt }, { id: 'o2', snapshotId: 'o1', capturedAt: page.capturedAt }],
  }, finalVisitId: 'o2', feedback: { unsupportedAnswer: 'MUST NOT reach the extractor' },
};
const signal = new AbortController().signal;
const options = { apiKey: 'test-key' };
test('one Gateway call carries the locked Zod schema and snapshot-only evidence, with no separate validation', async () => {
  let calls = 0, validations = 0;
  const contract = { ...input.contract, parser: input.contract.parser.superRefine(() => { validations++; }) };
  const extractor = new GatewayFinalizer({ ...options, async fetch(url, init) {
    calls++;
    assert.equal(new URL(String(url)).origin, 'https://ai-gateway.vercel.sh');
    assert.ok(new URL(String(url)).pathname.endsWith('/ai/language-model'));
    assert.equal(new Headers(init?.headers).get('ai-language-model-id'), DEFAULT_EXTRACTION_MODEL);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.responseFormat.type, 'json');
    assert.equal(body.responseFormat.name, 'browser_result');
    const schema = body.responseFormat.schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.anyOf, undefined);
    assert.deepEqual(schema.required, ['completion']);
    const complete = schema.properties.completion.anyOf.find((branch: any) => branch.properties.status.const === 'complete');
    assert.equal(complete.additionalProperties, false);
    assert.deepEqual(complete.properties.result.required, ['name', 'city', 'price']);
    assert.deepEqual(complete.properties.result.properties.city.enum, ['DemoCity']);
    assert.equal(complete.properties.result.properties.price.minimum, 0);
    assert.equal(complete.properties.result.additionalProperties, false);
    assert.ok(!body.tools?.length);
    const request = JSON.parse(body.prompt.find((message: any) => message.role === 'user').content[0].text);
    assert.deepEqual(request, { objective: input.objective,
      criteria: goal.criteria, snapshotHistory: input.snapshotHistory, finalVisitId: 'o2' });
    assert.ok(!JSON.stringify(body).includes('MUST NOT reach'));
    return gatewayResponse({ completion: { status: 'complete', result } });
  } });
  assert.deepEqual(await extractor.extract({ ...input, contract }, signal), { status: 'complete', result });
  assert.equal(calls, 1);
  assert.equal(validations, 1);
});
test('the structured call rejects coercion, extra fields, missing fields and invalid constraints', async () => {
  for (const value of [{ ...result, price: '120' }, { ...result, extra: true }, { name: 'Sample Stay' }, { ...result, city: 'OtherCity' }, { ...result, price: -1 }]) {
    const extractor = new GatewayFinalizer({ ...options, async fetch() {
      return gatewayResponse({ completion: { status: 'complete', result: value } });
    } });
    await assert.rejects(extractor.extract(input, signal), /did not match schema/);
  }
});
test('extractor can request more browser evidence instead of inventing a valid-looking result', async () => {
  const response = { status: 'needs_browser', reason: 'The nightly price is not visible' } as const;
  const extractor = new GatewayFinalizer({ ...options, async fetch() { return gatewayResponse({ completion: response }); } });
  assert.deepEqual(await extractor.extract(input, signal), response);
});
test('malformed, empty, refused and truncated responses never become a completed result', async () => {
  for (const value of ['{"completion":', '', 'I cannot fulfill this request.']) {
    const extractor = new GatewayFinalizer({ ...options, async fetch() { return gatewayResponse(value); } });
    await assert.rejects(extractor.extract(input, signal));
  }
  const truncated = new GatewayFinalizer({ ...options, async fetch() {
    return gatewayResponse({ completion: { status: 'complete', result } }, 'length');
  } });
  await assert.rejects(truncated.extract(input, signal), /Extraction ended: length/);
});
test('unsupported request errors are fatal without a text-generation fallback', async () => {
  let calls = 0;
  const extractor = new GatewayFinalizer({ ...options, async fetch() {
    calls++;
    return Response.json({ error: { message: 'Unsupported response schema' } }, { status: 400 });
  } });
  await assert.rejects(extractor.extract(input, signal), FatalError);
  assert.equal(calls, 1);
});
test('cancelled extraction makes no Gateway request', async () => {
  const extractor = new GatewayFinalizer({ ...options, async fetch() { throw new Error('Must not call Gateway'); } });
  await assert.rejects(extractor.extract(input, AbortSignal.abort(new Error('Cancelled'))), /Cancelled/);
});
