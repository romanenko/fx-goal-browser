// libfx 0.0.10 publishes JS without declarations. This adapter describes only
// the public API used here: https://fx.sh/docs/lib/api
declare module 'libfx' {
  export interface Agent {
    prompt(input: string, options?: { signal?: AbortSignal }): AsyncIterable<{ type: string; delta?: string }> & {
      result: Promise<{ stopReason: string; usage: unknown }>;
      cancel(): void;
    };
    close(): Promise<void>;
  }
  export function createFxAgent(options: {
    apiKey: string; model?: string; instructions?: string;
    fetch?: typeof globalThis.fetch; backend?: 'auto' | 'native' | 'wasm';
  }): Promise<Agent>;
  export function getBackendInfo(options: { surface: 'agent' }): Promise<{ backend: string }>;
}
