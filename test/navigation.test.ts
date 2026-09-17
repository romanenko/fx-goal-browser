import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import { runAgent } from '../src/agent.js';
import { RunStore } from '../src/store.js';
import type { Browser } from '../src/browser.js';
import { goal, tempRun } from './helpers.js';

test('direct addresses skip search; missing addresses use agentic search; --url wins', async () => {
  const cases = [
    { objective: 'Go to survey.example.test and tell me what questions they ask as part of the survey', expected: 'https://survey.example.test/', searches: 0 },
    { objective: 'Open survey.example.test/survey?step=1.', expected: 'https://survey.example.test/survey?step=1', searches: 0 },
    { objective: 'Open http://localhost:3000/survey.', expected: 'http://localhost:3000/survey', searches: 0 },
    { objective: 'Find the Example survey', expected: 'https://found.example/survey', searches: 1 },
    { objective: 'Find a survey mentioned by person@example.com', expected: 'https://found.example/survey', searches: 1 },
    { objective: 'Open survey.example.test', url: 'https://override.example', expected: 'https://override.example/', searches: 0 },
    { objective: 'List five articles from https://news.example.test/announcements/', query: '', expected: 'https://news.example.test/announcements/', searches: 0 },
    { objective: 'Find the latest company announcements', query: '   ', expected: 'https://found.example/survey', searches: 1 },
  ];
  for (const item of cases) {
    const directory = await tempRun(), controller = new AbortController();
    let opened: string | undefined, searches = 0, plans = 0;
    const plannedGoal = { ...goal, searchQuery: item.query ?? goal.searchQuery };
    try {
      await assert.rejects(runAgent({ objective: item.objective, url: item.url,
        model: { async complete() { plans++; return plannedGoal; } },
        search: async (objective, query) => { searches++; assert.equal(objective, item.objective); assert.equal(query, plannedGoal.searchQuery.trim() || objective); return 'https://found.example/survey'; },
        browser: { async open(url: string) { opened = url; controller.abort(); } } as Browser,
        policy: { async choose() { throw new Error('Should not decide'); } },
        finalizer: { async extract() { throw new Error('Should not extract'); } },
        store: new RunStore(directory), signal: controller.signal,
      }));
      assert.equal(opened, item.expected);
      assert.equal(searches, item.searches);
      assert.equal(plans, 1, 'Unused or blank search metadata must not restart goal planning');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
