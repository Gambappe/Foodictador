import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfigFile, sys } from 'typescript';
import { describe, expect, it } from 'vitest';
import { NODE_TEST_GLOBS, TEST_ROOTS, UI_TEST_GLOBS } from '../vitest.config.js';

/**
 * Toolchain invariants.
 *
 * The task DAG's §1 rules only hold if the toolchain keeps enforcing them, so the
 * settings that matter are asserted here rather than trusted. A future change that
 * loosens strictness or breaks the linter fails this suite with the reason attached.
 */

const repoRoot = new URL('..', import.meta.url);
const pathTo = (name: string): string => fileURLToPath(new URL(name, repoRoot));

interface TsConfig {
  compilerOptions: Record<string, unknown>;
  include: string[];
}
interface PackageJson {
  type: string;
  engines: Record<string, string>;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
}

// tsconfig.json is JSONC — it carries explanatory comments on purpose. Read it with the
// compiler's own parser rather than a hand-rolled comment stripper, so this test sees
// exactly what tsc sees.
const tsconfigFile = readConfigFile(pathTo('tsconfig.json'), (file) => sys.readFile(file));
const tsconfig = tsconfigFile.config as TsConfig;

const pkg = JSON.parse(readFileSync(pathTo('package.json'), 'utf8')) as PackageJson;

describe('tsconfig strictness', () => {
  it('parses without error', () => {
    expect(tsconfigFile.error).toBeUndefined();
  });

  // Named individually so a failure says which guarantee was dropped.
  const required = [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
    'verbatimModuleSyntax',
    'isolatedModules',
    'forceConsistentCasingInFileNames',
  ] as const;

  it.each(required)('has %s enabled', (option) => {
    expect(tsconfig.compilerOptions[option]).toBe(true);
  });

});

describe('vitest collection', () => {
  it('collects from every directory the tsconfig typechecks — in both directions', () => {
    // The bug this guards against, for real: `scripts/**` was missing from vitest's
    // include, so the tests for S1-S3 and P0.5 were silently skipped while the suite
    // reported green.
    //
    // The direction matters, and the first version of this test got it wrong. Asserting
    // TEST_ROOTS ⊆ include only catches a root vitest scans but tsc ignores. The failure
    // that actually happened is the opposite: a directory tsc typechecks that vitest
    // never scans. Adding "packages" to include and forgetting TEST_ROOTS would have kept
    // the old assertion green while skipping every test under it. So: set equality,
    // ignoring glob entries like `*.config.ts`, which are files rather than test roots.
    const directories = tsconfig.include.filter((entry) => !entry.includes('*'));
    expect([...directories].sort()).toEqual([...TEST_ROOTS].sort());
  });

  /**
   * SL-31: every test file on disk is matched by one of the project globs.
   *
   * The root-list check above is necessary and was not sufficient. P0.7 split one
   * `include` into two projects along a *file extension*, and the UI project's glob was
   * `src/ui/**` only — so a `.test.tsx` anywhere else matched neither project. Planting
   * one under `tests/guards/` with `expect(1).toBe(999)` typechecked clean and never ran;
   * the suite count did not move.
   *
   * A root-set comparison cannot see that, because the root was present and the glob
   * inside it was not. This walks the filesystem instead, so an uncollected test is a red
   * build regardless of which axis the next split happens along.
   */
  it('every *.test.ts(x) under TEST_ROOTS is matched by a project glob', () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const walk = (dir: string, prefix: string): string[] => {
      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return []; // a declared root that does not exist yet is the other test's problem
      }
      return entries.flatMap((entry) => {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) return walk(`${dir}/${entry.name}`, `${path}/`);
        return /\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    };

    const onDisk = TEST_ROOTS.flatMap((testRoot) => walk(testRoot, `${testRoot}/`));
    expect(onDisk.length).toBeGreaterThan(20); // an empty walk would pass vacuously

    // The globs are all `<root>/**/*.test.ts` or `.tsx`, so matching is an extension
    // check against the set of roots each glob family covers.
    const covered = new Set([...NODE_TEST_GLOBS, ...UI_TEST_GLOBS]);
    const uncollected = onDisk.filter((file) => {
      const testRoot = file.slice(0, file.indexOf('/'));
      const glob = file.endsWith('.tsx')
        ? `${testRoot}/**/*.test.tsx`
        : `${testRoot}/**/*.test.ts`;
      return !covered.has(glob);
    });
    expect(uncollected, 'these test files are typechecked but never run').toEqual([]);
  });
});

describe('package scripts', () => {
  // Other tasks invoke these by name: P0.5 runs gate0, G5 runs gate:cli and lint.
  it.each(['build', 'typecheck', 'test', 'lint', 'confit', 'gate0', 'gate:cli'])(
    'declares %s',
    (script) => {
      expect(pkg.scripts[script]).toBeTruthy();
    },
  );

  it('is an ES module targeting Node 20 or newer', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.engines['node']).toBe('>=20');
  });
});

describe('typescript version pin', () => {
  it('stays on a major below 6 so typescript-eslint keeps working', () => {
    // typescript-eslint 8.x declares peer typescript ">=4.8.4 <6.1.0". TypeScript 7 is
    // available and faster, but adopting it silently drops the linter — and the linter is
    // what enforces no-`any`, no-`!`, and the pure-kernel import ban. If you are here to
    // upgrade: confirm typescript-eslint supports the new major FIRST, then widen this.
    const range = pkg.devDependencies['typescript'];
    expect(range).toBeDefined();
    const major = Number(/(\d+)/.exec(range ?? '')?.[1]);
    expect(Number.isFinite(major)).toBe(true);
    expect(major).toBeLessThan(6);
  });
});
