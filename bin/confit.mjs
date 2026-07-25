#!/usr/bin/env node
/**
 * The `confit` binary (DEPLOY.1).
 *
 * A shim rather than a second entrypoint. `src/cli/main.ts` decides whether to execute by
 * comparing `import.meta.url` against `process.argv[1]` — so a wrapper that merely imports
 * it loads the module and runs nothing. Rewriting `argv[1]` to the module's own path makes
 * that check true, which keeps X1's self-execution logic (including its EPIPE handling for
 * `confit pass census | head -3`) the single source of truth instead of copied here and
 * left to drift.
 *
 * `argv.slice(2)` downstream is unaffected: argv[0] is node, argv[1] is the path we just
 * rewrote, and the user's arguments still start at index 2.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const main = fileURLToPath(new URL('../dist/src/cli/main.js', import.meta.url));

if (!existsSync(main)) {
  process.stderr.write(
    'confit: dist/ is missing — run `npm run build` first.\n' +
      'If you installed this as a package, the build step did not run.\n',
  );
  process.exit(1);
}

process.argv[1] = main;
await import(main);
