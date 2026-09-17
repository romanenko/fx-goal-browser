import { createGateway, generateText, Output } from 'ai';
import { z } from 'zod';
import type { Contract, JsonObject } from './contracts.js';
import { FatalError } from './model.js';
import type { SnapshotHistory } from './store.js';
import { EXTRACT } from './prompts.js';

export const DEFAULT_EXTRACTION_MODEL = 'openai/gpt-5.6-luna';

export interface FinishInput {
  objective: string;
  contract: Contract;
  snapshotHistory: SnapshotHistory;
  finalVisitId: string;
}
export type FinishResult = { status: 'complete'; result: JsonObject } | { status: 'needs_browser'; reason: string };
export interface Finalizer {
  readonly model?: string;
  extract(input: FinishInput, signal: AbortSignal): Promise<FinishResult>;
}

// One tool-free structured call. The SDK handles generation and schema checking.
export class GatewayFinalizer implements Finalizer {
  constructor(private options: { apiKey: string; model?: string; fetch?: typeof globalThis.fetch }) {}
  get model(): string { return this.options.model ?? DEFAULT_EXTRACTION_MODEL; }
  async extract(input: FinishInput, signal: AbortSignal): Promise<FinishResult> {
    signal.throwIfAborted();
    const gateway = createGateway({ apiKey: this.options.apiKey, fetch: this.options.fetch });
    // OpenAI requires an object at the root; the outcome union is nested inside it.
    const schema = z.strictObject({
      completion: z.union([
        z.strictObject({ status: z.literal('complete'), result: input.contract.parser }),
        z.strictObject({ status: z.literal('needs_browser'), reason: z.string().min(1).max(2000) }),
      ]),
    });
    try {
      const response = await generateText({
        model: gateway(this.model),
        output: Output.object({ schema, name: 'browser_result' }),
        system: EXTRACT,
        prompt: JSON.stringify({
          objective: input.objective, criteria: input.contract.goal.criteria,
          snapshotHistory: input.snapshotHistory, finalVisitId: input.finalVisitId,
        }),
        abortSignal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
      });
      signal.throwIfAborted();
      if (response.finishReason !== 'stop') throw new Error(`Extraction ended: ${response.finishReason}`);
      return response.output.completion;
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
        && error.statusCode >= 400 && error.statusCode < 500 && ![408, 409, 429].includes(error.statusCode)) {
        throw new FatalError(`Gateway extraction HTTP ${error.statusCode}: ${error.message}`);
      }
      throw error;
    }
  }
}
