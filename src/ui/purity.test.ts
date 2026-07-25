/**
 * U1's purity acceptance: `src/ui/**` imports no `node:*` module.
 *
 * A `.test.ts`, not `.test.tsx`, on purpose — it runs under the node project (see
 * vitest.config.ts) because it reads the source text it asserts about, and jsdom has
 * no filesystem. eslint's matching rule is the fast feedback; this is the one that
 * survives someone disabling the rule inline, and it also catches a dynamic
 * `import('node:fs')` that a static import rule would not flag as an import.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const UI_DIR = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Matches static imports, `export … from`, and dynamic `import()` alike. */
const NODE_IMPORT = /(?:from\s*|import\s*\(\s*)['"]node:[^'"]+['"]/;

/**
 * Exempt for the same reason and by the same rule eslint.config.js uses: `.test.ts`
 * under `src/ui/**` runs in the node project and never reaches the browser bundle, so a
 * `node:` import there is legal. This used to exempt only `purity.test.ts` by filename,
 * which made this check disagree with the lint rule beside it — the lint rule allowed a
 * second such test, and this one failed it. Rendered tests are `.test.tsx`, run under
 * jsdom, and stay covered.
 */
const isNodeProjectTest = (path: string): boolean => path.endsWith('.test.ts');

describe('U1: src/ui/** stays browser-safe', () => {
  const files = sourceFiles(UI_DIR).filter((path) => !isNodeProjectTest(path));

  it('finds the UI source to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((path) => [path.slice(UI_DIR.length), path]))(
    '%s imports no node: module',
    (_label, path) => {
      const offending = readFileSync(path, 'utf8')
        .split('\n')
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => NODE_IMPORT.test(line));
      expect(offending).toEqual([]);
    },
  );
});
