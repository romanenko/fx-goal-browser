import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observation } from './browser.js';

export interface SnapshotHistory {
  snapshots: { id: string; url: string; text: string; truncated: boolean }[];
  visits: { id: string; snapshotId: string; capturedAt: string }[];
}

export class RunStore {
  private snapshots = new Map<string, SnapshotHistory['snapshots'][number]>();
  private visits: SnapshotHistory['visits'] = [];
  constructor(readonly directory: string) {}
  async init(): Promise<void> {
    await mkdir(join(this.directory, 'observations'), { recursive: true, mode: 0o700 });
  }
  async save(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  }
  async event(type: string, detail: unknown): Promise<void> {
    await appendFile(join(this.directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, detail }) + '\n', { mode: 0o600 });
  }
  async observe(observation: Observation): Promise<void> {
    await this.save(`observations/${observation.id}.json`, observation);
    // Element text reads are not accessibility snapshots or extraction evidence.
    if (observation.readRef) return;
    const key = JSON.stringify([observation.url, observation.snapshot, observation.truncated]);
    let snapshot = this.snapshots.get(key);
    if (!snapshot) {
      snapshot = { id: observation.id, url: observation.url, text: observation.snapshot, truncated: observation.truncated };
      this.snapshots.set(key, snapshot);
    }
    this.visits.push({ id: observation.id, snapshotId: snapshot.id, capturedAt: observation.capturedAt });
  }
  snapshotHistory(): SnapshotHistory {
    return { snapshots: [...this.snapshots.values()], visits: [...this.visits] };
  }
}
