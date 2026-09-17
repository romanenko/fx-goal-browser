import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// This is a deliberately small JSON Schema dialect. No executable model code,
// remote references, coercion, defaults, regexes, or unknown schema keywords.
export type ResultSchema =
  | { type: 'object'; properties: Record<string, ResultSchema>; required: string[]; additionalProperties: false }
  | { type: 'array'; items: ResultSchema; minItems?: number; maxItems?: number }
  | { type: 'string'; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' };

const boundedInt = z.number().int().min(0).max(100_000);
export const resultSchema: z.ZodType<ResultSchema> = z.lazy(() => z.union([
  z.strictObject({
    type: z.literal('object'), properties: z.record(z.string(), resultSchema),
    required: z.array(z.string()), additionalProperties: z.literal(false),
  }),
  z.strictObject({ type: z.literal('array'), items: resultSchema, minItems: boundedInt.optional(), maxItems: boundedInt.optional() }),
  z.strictObject({ type: z.literal('string'), enum: z.array(z.string()).min(1).optional(), minLength: boundedInt.optional(), maxLength: boundedInt.optional() }),
  z.strictObject({ type: z.enum(['number', 'integer']), minimum: z.number().optional(), maximum: z.number().optional() }),
  z.strictObject({ type: z.enum(['boolean', 'null']) }),
]));

export const goalSchema = z.strictObject({
  summary: z.string().min(1).max(2000),
  searchQuery: z.string().max(1000),
  resultSchema,
  criteria: z.array(z.strictObject({
    id: z.string().regex(/^c[1-9]\d*$/),
    requirement: z.string().min(1).max(2000),
    evidence: z.enum(['current_page', 'observed_page']),
  })).min(1).max(30),
});
export type Goal = z.infer<typeof goalSchema>;

export function parseJson(text: string): unknown {
  if (text.length > 1_000_000) throw new Error('JSON exceeds 1 MB');
  const value: unknown = JSON.parse(text); // Markdown, trailing text, NaN and comments fail.
  function inspect(item: unknown, depth: number): void {
    if (depth > 16) throw new Error('JSON nesting exceeds 16 levels');
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite JSON number');
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Unsafe JSON property');
        inspect(child, depth + 1);
      }
    }
  }
  inspect(value, 0);
  return value;
}

export function compileGoal(input: unknown) {
  const goal = goalSchema.parse(input);
  if (goal.resultSchema.type !== 'object') throw new Error('The result schema must describe an object');
  if (new Set(goal.criteria.map(c => c.id)).size !== goal.criteria.length) throw new Error('Duplicate criterion ID');
  let nodes = 0;
  function inspect(schema: ResultSchema, depth = 0): void {
    if (++nodes > 200 || depth > 8) throw new Error('Result schema is too complex');
    if (schema.type === 'object') {
      const keys = Object.keys(schema.properties);
      if (!keys.length || keys.some(k => !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k) || ['constructor', 'prototype', '__proto__'].includes(k))) {
        throw new Error('Use nonempty objects with simple property names');
      }
      if (new Set(schema.required).size !== keys.length || schema.required.length !== keys.length || keys.some(k => !schema.required.includes(k))) {
        throw new Error('Every property must be required (no silently missing result fields)');
      }
      for (const child of Object.values(schema.properties)) inspect(child, depth + 1);
    } else if (schema.type === 'array') inspect(schema.items, depth + 1);
    if ('minimum' in schema && 'maximum' in schema && schema.minimum! > schema.maximum!) throw new Error('Reversed numeric bounds');
    if ('minItems' in schema && 'maxItems' in schema && schema.minItems! > schema.maxItems!) throw new Error('Reversed array bounds');
    if ('minLength' in schema && 'maxLength' in schema && schema.minLength! > schema.maxLength!) throw new Error('Reversed string bounds');
  }
  inspect(goal.resultSchema);
  const parser = compileResult(goal.resultSchema) as z.ZodType<JsonObject>;
  // The goal defines a runtime type. No later browser turn can replace this parser.
  return { goal, parser };
}
export type Contract = ReturnType<typeof compileGoal>;

function compileResult(schema: ResultSchema): z.ZodType<Json> {
  switch (schema.type) {
    case 'object': return z.strictObject(Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, compileResult(child)])));
    case 'array': {
      let parser = z.array(compileResult(schema.items));
      if (schema.minItems !== undefined) parser = parser.min(schema.minItems);
      if (schema.maxItems !== undefined) parser = parser.max(schema.maxItems);
      return parser;
    }
    case 'string': {
      if (schema.enum) {
        // Native enum values survive conversion to the provider's JSON Schema.
        const values = schema.enum.filter(value => value.length >= (schema.minLength ?? 0)
          && value.length <= (schema.maxLength ?? Infinity));
        if (!values.length) throw new Error('No enum value satisfies the string bounds');
        return z.enum(values);
      }
      let parser = z.string();
      if (schema.minLength !== undefined) parser = parser.min(schema.minLength);
      if (schema.maxLength !== undefined) parser = parser.max(schema.maxLength);
      return parser;
    }
    case 'number': case 'integer': {
      let parser = z.number();
      if (schema.type === 'integer') parser = parser.int();
      if (schema.minimum !== undefined) parser = parser.min(schema.minimum);
      if (schema.maximum !== undefined) parser = parser.max(schema.maximum);
      return parser;
    }
    case 'boolean': return z.boolean();
    case 'null': return z.null();
  }
}

const ref = z.string().regex(/^@e[1-9]\d*$/);
export const actionSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('observe') }),
  z.strictObject({ op: z.literal('blocked') }),
  z.strictObject({ op: z.literal('back') }),
  z.strictObject({ op: z.literal('click'), ref }),
  z.strictObject({ op: z.literal('fill'), ref, text: z.string().max(10_000) }),
  z.strictObject({ op: z.literal('select'), ref, value: z.string().max(1000) }),
  z.strictObject({ op: z.literal('check'), ref, checked: z.boolean() }),
  z.strictObject({ op: z.literal('press'), ref, key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space']) }),
  z.strictObject({ op: z.literal('scroll'), direction: z.enum(['up', 'down']), pixels: z.number().int().min(100).max(2000) }),
  z.strictObject({ op: z.literal('wait'), milliseconds: z.number().int().min(100).max(2000) }),
  z.strictObject({ op: z.literal('read'), ref }),
  z.strictObject({ op: z.literal('finish') }),
]);
export type Action = z.infer<typeof actionSchema>;
