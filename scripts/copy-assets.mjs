#!/usr/bin/env node
/**
 * Copies the JSON the built CLI reads at runtime into `dist/`.
 *
 * `tsc` compiles TypeScript and copies nothing else, so a `dist/` built without this step
 * **cannot boot at all**: `src/contracts/fixtures/index.ts` reads `./pool-baseline.json`
 * beside its own module at import time, so `node dist/src/cli/main.js --help` died with
 * ENOENT before dispatching a single command.
 *
 * That went unnoticed because nothing ever ran the built artifact. `npm run build` checked
 * that the code *compiles*, `npm test` ran the TypeScript sources through vitex, and
 * `scripts/gate-cli.sh` invoked no subcommand whatsoever (defect SL-26). The gate now boots
 * `dist/src/cli/main.js`, which is what surfaced this.
 *
 * Two kinds of asset, both resolved through `import.meta.url` and therefore both sensitive
 * to where they sit relative to the emitted JS:
 *
 *   - fixtures beside their module     `src/contracts/fixtures/*.json` → `dist/src/…`
 *   - the data directory              `data/**` → `dist/data/**`, because `../../data/…`
 *                                     from `dist/src/cli/` resolves there
 *
 * Verified by the gate rather than asserted here: if a new runtime JSON read is added
 * without extending `ASSETS`, `gate-cli.sh`'s `cli boots` step goes red.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');

/** `from` is repo-relative; `to` is dist-relative. Directories copy recursively. */
const ASSETS = [
  { from: 'src/contracts/fixtures', to: 'src/contracts/fixtures' },
  { from: 'data', to: 'data' },
];

if (!existsSync(dist)) {
  // Not a warning to swallow: a copy step that silently no-ops when the compiler did not
  // run would make `npm run build` look like it succeeded.
  console.error('copy-assets: dist/ does not exist — run tsc first');
  process.exit(1);
}

let copied = 0;
for (const { from, to } of ASSETS) {
  const source = join(root, from);
  if (!existsSync(source)) {
    console.error(`copy-assets: ${from} is missing from the repo`);
    process.exit(1);
  }
  const target = join(dist, to);
  mkdirSync(dirname(target), { recursive: true });
  // JSON only: the point is runtime data, and a blanket copy would drag sources into dist.
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !path.endsWith('.ts') && !path.endsWith('.tsx'),
  });
  copied += 1;
}

console.log(`copy-assets: ${copied} asset path(s) → dist/`);
