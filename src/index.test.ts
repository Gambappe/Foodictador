import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConfigFile, sys } from 'typescript';
import { describe, expect, it } from 'vitest';
import { TEST_ROOTS } from '../vitest.config.js';

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

  it('covers every lane directory that holds TypeScript', () => {
    // A lane missing from `include` is a lane that is never typechecked.
    expect(tsconfig.include).toEqual(expect.arrayContaining([...TEST_ROOTS]));
  });
});

describe('vitest collection', () => {
  it('can collect tests from every directory the tsconfig typechecks', () => {
    // Caught for real: `scripts/**` was missing from vitest's include, so the tests for
    // S1-S3 and P0.5 — all of which live under scripts/ — would have been silently
    // skipped while the suite reported green.
    for (const root of TEST_ROOTS) {
      expect(tsconfig.include).toContain(root);
    }
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
