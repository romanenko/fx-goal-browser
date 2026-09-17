import { createFxAgent } from 'libfx';
import { parseJson } from './contracts.js';

export interface Model {
  complete(phase: 'plan' | 'text', instructions: string, input: unknown, signal: AbortSignal): Promise<unknown>;
}
export class FatalError extends Error {}

export class FxModel implements Model {
  constructor(private options: { apiKey: string; model?: string; fetch?: typeof globalThis.fetch }) {
    if (!options.apiKey) throw new FatalError('Set AI_GATEWAY_API_KEY in .env or your environment to run fx.');
  }

  async complete(_phase: 'plan' | 'text', instructions: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    let fatalStatus: number | undefined;
    const transport = this.options.fetch ?? globalThis.fetch;
    // Each bounded fx conversation has a single job and no browser tools.
    const agent = await createFxAgent({
      apiKey: this.options.apiKey,
      model: this.options.model,
      instructions,
      fetch: async (url, init) => {
        const response = await transport(url, { ...init, signal: AbortSignal.any([
          signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(120_000),
        ]) });
        if ([400, 401, 402, 403, 404].includes(response.status)) fatalStatus = response.status;
        return response;
      },
    });
    try {
      const turn = agent.prompt(JSON.stringify(input), { signal });
      // Attach a handler immediately; the async iterator may fail before result.
      const completion = turn.result;
      void completion.catch(() => {});
      let text = '';
      for await (const event of turn) {
        if (event.type === 'text_delta') text += event.delta ?? '';
        if (text.length > 1_000_000) { turn.cancel(); throw new Error('Model response exceeds 1 MB'); }
      }
      const result = await completion;
      signal.throwIfAborted();
      if (result.stopReason !== 'end_turn') throw new Error(`fx turn ended: ${result.stopReason}`);
      return parseJson(text);
    } catch (error) {
      if (fatalStatus) throw new FatalError(`fx provider HTTP ${fatalStatus}; check the API key, model, and account credits.`);
      throw error;
    } finally {
      await agent.close();
    }
  }
}
