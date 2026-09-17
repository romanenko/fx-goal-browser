import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';

await build({
  entryPoints: ['src/cli.ts'], outfile: 'dist/cli.js', bundle: true,
  platform: 'node', target: 'node24', format: 'esm', external: ['libfx', 'playwright'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await chmod('dist/cli.js', 0o755);
console.error('Built dist/cli.js');
