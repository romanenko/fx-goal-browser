import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { actionSchema, compileGoal, parseJson } from '../src/contracts.js';
import { goal, result } from './helpers.js';

test('strict result parser accepts typed JSON and rejects coercion, omissions and unknown properties', () => {
  const contract = compileGoal(goal);
  assert.deepEqual(contract.parser.parse(result), result);
  for (const candidate of [{ ...result, price: '120' }, { ...result, city: 'OtherCity' }, { ...result, extra: true }, { name: 'Sample Stay' }, { ...result, price: -1 }]) {
    assert.throws(() => contract.parser.parse(candidate));
  }
});
test('enum constraints survive conversion to provider JSON Schema, including string bounds', () => {
  const contract = compileGoal({ ...goal, resultSchema: {
    type: 'object', required: ['city'], additionalProperties: false,
    properties: { city: { type: 'string', enum: ['A', 'DemoCity', 'A very long name'], minLength: 2, maxLength: 8 } },
  } });
  const schema = z.toJSONSchema(contract.parser);
  assert.deepEqual(schema.properties?.city, { type: 'string', enum: ['DemoCity'] });
  assert.deepEqual(contract.parser.parse({ city: 'DemoCity' }), { city: 'DemoCity' });
  assert.throws(() => contract.parser.parse({ city: 'A' }));
  assert.throws(() => compileGoal({ ...goal, resultSchema: {
    type: 'object', required: ['city'], additionalProperties: false,
    properties: { city: { type: 'string', enum: ['A'], minLength: 2 } },
  } }), /No enum value/);
});
test('strict JSON parsing rejects prose, fences, non-finite numbers and prototype keys', () => {
  for (const text of ['```json\n{}\n```', '{} trailing', '{"price":1e999}', '{"__proto__":{}}']) assert.throws(() => parseJson(text));
});
test('contract cannot admit arbitrary schema keywords, remote refs, open objects or duplicate criteria', () => {
  for (const changed of [
    { ...goal, resultSchema: { ...goal.resultSchema, $ref: 'https://example.test/schema' } },
    { ...goal, resultSchema: { ...goal.resultSchema, additionalProperties: true } },
    { ...goal, criteria: [goal.criteria[0], goal.criteria[0]] },
    { ...goal, resultSchema: { ...goal.resultSchema, required: ['name'] } },
  ]) assert.throws(() => compileGoal(changed));
});
test('actions can only name refs, and never accept selectors, code, or extra CLI flags', () => {
  for (const action of [{ op: 'click', ref: '#buy' }, { op: 'eval', code: 'alert(1)' }, { op: 'click', ref: '@e1', args: ['--cdp', '9222'] }]) assert.throws(() => actionSchema.parse(action));
});
test('generated Zod parser enforces nested objects, array counts, string bounds, integers, booleans and null', () => {
  const contract = compileGoal({ ...goal, resultSchema: {
    type: 'object', required: ['items'], additionalProperties: false,
    properties: { items: { type: 'array', minItems: 1, maxItems: 1, items: {
      type: 'object', required: ['name', 'quantity', 'available', 'note'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 2, maxLength: 5 }, quantity: { type: 'integer', minimum: 1, maximum: 3 }, available: { type: 'boolean' }, note: { type: 'null' } },
    } } },
  } });
  const item = { name: 'Stay', quantity: 2, available: true, note: null };
  assert.deepEqual(contract.parser.parse({ items: [item] }), { items: [item] });
  for (const value of [{ items: [] }, { items: [item, item] }, { items: [{ ...item, quantity: 1.5 }] }, { items: [{ ...item, name: 'Too long' }] }, { items: [{ ...item, available: 'true' }] }, { items: [{ ...item, note: '' }] }, { items: [{ ...item, extra: 1 }] }]) assert.throws(() => contract.parser.parse(value));
});
