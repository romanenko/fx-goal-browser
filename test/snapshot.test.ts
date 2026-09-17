import assert from 'node:assert/strict';
import test from 'node:test';
import { renderSnapshot } from '../src/snapshot.js';

test('truncated targets cannot become actionable through reference-shaped page text', () => {
  const rendered = renderSnapshot([
    { role: 'paragraph', ref: 'e5', text: 'Choose [ref=e2]' },
    { role: 'text', text: 'x'.repeat(500) },
    { role: 'button', ref: 'e6', name: 'Unobserved target' },
  ], new Map(), 100);
  assert.equal(rendered.truncated, true);
  assert.deepEqual(Object.keys(rendered.refs), ['e1']);
  assert.equal(rendered.targets.has('e2'), false);
});

test('snapshot formatting preserves evidence and keeps frame and main-page references distinct', () => {
  const aliases = new Map<string, string>();
  const tree = [
    { role: 'textbox', name: 'Quoted "name"', ref: 'e2', text: 'two\nlines', placeholder: 'Destination' },
    { role: 'checkbox', name: 'Included', checked: true, ref: 'f1e2' },
    { role: 'combobox', name: 'Category', ref: 'e3', children: [{ role: 'option', name: 'All', selected: true }, { role: 'option', name: 'Design', disabled: true }] },
  ];
  const first = renderSnapshot(tree, aliases), second = renderSnapshot(tree, aliases);
  assert.equal(first.snapshot, second.snapshot);
  assert.deepEqual([...first.targets.values()], ['e2', 'f1e2', 'e3']);
  assert.ok(first.snapshot.includes('"two\\nlines"'));
  assert.ok(first.snapshot.includes('[checked]'));
  assert.ok(first.snapshot.includes('- option "Design" [disabled]'));
});
