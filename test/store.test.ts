import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { RunStore } from '../src/store.js';
import { observation, tempRun } from './helpers.js';

test('snapshot history preserves revisits without duplicating text or including raw reads and browser metadata', async () => {
  const dir = await tempRun();
  const store = new RunStore(dir);
  try {
    await store.init();
    const first = { ...observation('o1'), snapshot: 'First question?', fingerprint: 'first', refs: { e1: { role: 'button', name: 'Answer' } } };
    const second = { ...observation('o2'), snapshot: 'Second question?', fingerprint: 'second' };
    await store.observe(first);
    await store.observe(second);
    await store.observe({ ...first, id: 'o3' });
    await store.observe({ ...observation('o4'), readRef: '@e1', snapshot: 'Raw element text is not an accessibility snapshot' });
    const history = store.snapshotHistory();
    assert.deepEqual(history.snapshots, [first, second].map(page => ({ id: page.id, url: page.url, text: page.snapshot, truncated: false })));
    assert.deepEqual(history.visits.map(({ id, snapshotId }) => [id, snapshotId]), [['o1', 'o1'], ['o2', 'o2'], ['o3', 'o1']]);
    assert.equal(history.visits[0]?.capturedAt, first.capturedAt);
    for (const unwanted of ['fingerprint', 'refs', 'readRef', 'Raw element text']) assert.ok(!JSON.stringify(history).includes(unwanted));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
