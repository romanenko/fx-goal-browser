import { z } from 'zod';

interface AriaNode {
  role: string;
  name?: string;
  ref?: string;
  text?: string;
  url?: string;
  placeholder?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean | string;
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
  children?: (AriaNode | string)[];
}
const nodeSchema: z.ZodType<AriaNode | string> = z.lazy(() => z.union([
  z.string(), z.object({
    role: z.string(), name: z.string().optional(), ref: z.string().regex(/^(?:f\d+)?e\d+$/).optional(),
    text: z.string().optional(), url: z.string().optional(), placeholder: z.string().optional(),
    checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
    disabled: z.boolean().optional(), expanded: z.boolean().optional(), active: z.boolean().optional(),
    invalid: z.union([z.boolean(), z.string()]).optional(), level: z.number().optional(),
    pressed: z.union([z.boolean(), z.literal('mixed')]).optional(), selected: z.boolean().optional(),
    children: z.array(nodeSchema).optional(),
  }),
]));

// Format Playwright's native ARIA tree; this does not inspect or reconstruct the DOM.
export function renderSnapshot(input: unknown, aliases: Map<string, string>, limit = 24_000) {
  const refs: Record<string, { role: string; name?: string }> = {};
  const targets = new Map<string, string>();
  const refLines = new Map<string, number>();
  const lines: string[] = [];
  function visit(node: AriaNode | string, depth: number): void {
    const indent = '  '.repeat(depth);
    if (typeof node === 'string') { lines.push(`${indent}- text: ${JSON.stringify(node)}`); return; }
    let label = `${indent}- ${node.role}${node.name === undefined ? '' : ` ${JSON.stringify(node.name)}`}`;
    if (node.ref) {
      let ref = aliases.get(node.ref);
      if (!ref) { ref = `e${aliases.size + 1}`; aliases.set(node.ref, ref); }
      refs[ref] = { role: node.role, ...(node.name === undefined ? {} : { name: node.name }) };
      targets.set(ref, node.ref);
      refLines.set(ref, lines.length);
      label += ` [ref=${ref}]`;
    }
    for (const key of ['checked', 'disabled', 'expanded', 'active', 'invalid', 'level', 'pressed', 'selected'] as const) {
      const value = node[key];
      if (value !== undefined && value !== false) label += value === true ? ` [${key}]` : ` [${key}=${JSON.stringify(value)}]`;
    }
    lines.push(`${label}${node.text === undefined ? '' : `: ${JSON.stringify(node.text)}`}`);
    for (const key of ['url', 'placeholder'] as const) {
      if (node[key] !== undefined) lines.push(`${indent}  - /${key}: ${JSON.stringify(node[key])}`);
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  }
  for (const node of z.array(nodeSchema).parse(input)) visit(node, 0);
  let length = 0, included = 0;
  for (const line of lines) {
    const next = length + (included ? 1 : 0) + line.length;
    if (next > limit) break;
    length = next;
    included++;
  }
  const snapshot = lines.slice(0, included).join('\n');
  // Page text that happens to contain "[ref=eN]" cannot expose a truncated target.
  const visibleRefs = new Set([...refLines].filter(([, line]) => line < included).map(([ref]) => ref));
  return {
    snapshot, truncated: included < lines.length,
    refs: Object.fromEntries(Object.entries(refs).filter(([key]) => visibleRefs.has(key))),
    targets: new Map([...targets].filter(([key]) => visibleRefs.has(key))),
  };
}
