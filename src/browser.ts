import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser as ChromiumBrowser, type Page } from 'playwright';
import { actionSchema, type Action } from './contracts.js';
import { FatalError } from './model.js';
import { renderSnapshot } from './snapshot.js';

export interface Observation {
  id: string;
  url: string;
  snapshot: string;
  refs: Record<string, { role: string; name?: string }>;
  fingerprint: string;
  truncated: boolean;
  capturedAt: string;
  readRef?: string;
}
export interface Browser {
  open(url: string, signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal): Promise<Observation>;
  fresh(observation: Observation, signal: AbortSignal): Promise<boolean>;
  act(action: Action, observation: Observation, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export class StaleObservation extends Error {}

export function httpUrl(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) URL without credentials');
  return url.href;
}

export class PlaywrightBrowser implements Browser {
  private launch?: Promise<ChromiumBrowser>;
  private page?: Page;
  private closing?: Promise<void>;
  private sequence = 0;
  private navigation = 0;
  private aliases = new Map<string, string>();
  private current?: { observation: Observation; targets: Map<string, string> };
  private runSignal?: AbortSignal;
  private onAbort = () => { void this.close().catch(() => {}); };
  constructor(private options: { headed?: boolean } = {}) {}

  private livePage(): Page {
    if (!this.page || this.page.isClosed() || this.closing) throw new FatalError('The browser session is closed. Start a new run.');
    return this.page;
  }

  async open(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const address = httpUrl(url);
    if (this.closing) throw new FatalError('The browser session is closed. Start a new run.');
    if (!this.launch) {
      this.runSignal = signal;
      signal.addEventListener('abort', this.onAbort, { once: true });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) =>
        value !== undefined && !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))) as Record<string, string>;
      // One owned Chromium process and Page for the entire run; no command subprocesses.
      this.launch = chromium.launch({ headless: !this.options.headed, env, timeout: 30_000 });
      let browser: ChromiumBrowser;
      try { browser = await this.launch; }
      catch (error) {
        signal.throwIfAborted();
        throw new FatalError(`Could not start Chromium. Run npm run browser:install. ${error instanceof Error ? error.message : String(error)}`);
      }
      signal.throwIfAborted();
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(30_000);
      this.page = await context.newPage();
      this.page.on('framenavigated', () => {
        this.navigation++;
        this.current = undefined;
        this.aliases.clear();
      });
    }
    this.current = undefined;
    await this.livePage().goto(address, { waitUntil: 'domcontentloaded', signal });
  }

  private async capture(signal: AbortSignal) {
    signal.throwIfAborted();
    const page = this.livePage(), url = page.url(), navigation = this.navigation;
    const tree: unknown = await page.ariaSnapshotJSON({ mode: 'ai', signal });
    if (navigation !== this.navigation || url !== page.url()) throw new StaleObservation('Page navigated during observation. Observe again.');
    const rendered = renderSnapshot(tree, this.aliases);
    return {
      ...rendered, url, capturedAt: new Date().toISOString(),
      // Hash all evidence, including content beyond the model's snapshot limit.
      fingerprint: createHash('sha256').update(JSON.stringify([url, navigation, tree])).digest('hex'),
    };
  }

  async observe(signal: AbortSignal): Promise<Observation> {
    const { targets, ...page } = await this.capture(signal);
    const observation = { ...page, id: `o${++this.sequence}` };
    this.current = { observation, targets };
    return observation;
  }

  async fresh(observation: Observation, signal: AbortSignal): Promise<boolean> {
    return (await this.capture(signal)).fingerprint === observation.fingerprint;
  }

  async act(input: Action, observation: Observation, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const action = actionSchema.parse(input), current = this.current;
    if (current?.observation.id !== observation.id) throw new StaleObservation('Observe before acting');
    // Consume a decision once, including failures whose effect is uncertain.
    this.current = undefined;
    const nativeRef = 'ref' in action ? current.targets.get(action.ref.slice(1)) : undefined;
    if ('ref' in action && (!Object.hasOwn(observation.refs, action.ref.slice(1)) || !nativeRef)) throw new Error('Choose an @eN reference from the current observation');
    if (!await this.fresh(observation, signal)) throw new StaleObservation('Page changed while choosing. Observe and choose again.');
    const page = this.livePage();
    // Native refs resolve the actual snapshotted node, including refs inside frames.
    // Pin Playwright and exercise this selector engine in real-browser tests.
    const target = nativeRef ? page.locator(`aria-ref=${nativeRef}`) : undefined;
    switch (action.op) {
      case 'click': await target!.click({ signal }); break;
      case 'fill': await target!.fill(action.text, { signal }); break;
      case 'select': await target!.selectOption({ label: action.value }, { signal }); break;
      case 'check': await target!.setChecked(action.checked, { signal }); break;
      case 'press': await target!.press(action.key, { signal }); break;
      case 'scroll':
        await page.evaluate(({ direction, pixels }) => window.scrollBy({ top: direction === 'down' ? pixels : -pixels, behavior: 'instant' }), action);
        break;
      case 'wait': await delay(action.milliseconds, undefined, { signal }); break;
      case 'back': await page.goBack({ waitUntil: 'domcontentloaded', signal }); break;
      case 'read': {
        const text = await target!.innerText({ signal });
        const observed: Observation = {
          id: `o${++this.sequence}`, url: page.url(), snapshot: text.slice(0, 24_000), refs: {},
          fingerprint: createHash('sha256').update(text).digest('hex'),
          truncated: text.length > 24_000, capturedAt: new Date().toISOString(), readRef: action.ref,
        };
        return { executed: 'read', observation: observed };
      }
      default: throw new Error('This is not a browser action');
    }
    signal.throwIfAborted();
    return { executed: action.op };
  }

  close(): Promise<void> {
    this.current = undefined;
    this.runSignal?.removeEventListener('abort', this.onAbort);
    return this.closing ??= (async () => {
      const browser = await this.launch?.catch(() => undefined);
      await browser?.close();
    })();
  }
}
