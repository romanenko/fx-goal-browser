# fx-goal-browser

An experiment in fast, goal-driven browser use. Give it an objective in plain
language; get a structured JSON answer.

1. **Set the goal.** [fx](https://fx.sh/) turns your request into a clear objective
   and decides what information counts as success.
2. **Define the result.** Before browsing, the agent creates a Zod schema: a
   contract for the answer's fields, types, and constraints.
3. **Browse fast.** Jev follows **observe → choose a reference → act**, using
   accessibility snapshots to select page elements. One persistent Playwright
   browser keeps actions fast. It works toward the goal across pages and steps.
4. **Extract the answer.** Once the information is available, Luna reads the
   recorded snapshots and returns the answer in one structured-output call,
   with the goal's Zod schema supplied directly to that call.

All AI calls go through **Vercel AI Gateway**. A URL in your prompt is used
directly; otherwise, agentic web search finds a starting page.

## Try it

Requires **Node.js 24+**. Uses **TypeScript 7**.

```sh
npm ci
npm run browser:install
npm run build
cp .env.example .env
```

Set `AI_GATEWAY_API_KEY` in `.env`, then run:

```sh
node dist/cli.js --headed "Find the top 5 movies currently trending on Rotten Tomatoes to watch at home. Rank them by Popcornmeter score, highest first. Return each movie's title, score, and URL."
```

The result goes to stdout as JSON; progress goes to stderr. There is no default
step limit. Ctrl+C cancels. Use `--help` for model overrides and other options.

Run checks with `npm run check && npm test`. Measure local browser speed with
`npm run bench`. Tests use fictional fixtures and make no paid AI calls.

Credentials and browsing records stay in ignored `.env` and `runs/` files.
