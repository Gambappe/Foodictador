import { defineConfig } from 'vitest/config';

/** Every directory the tsconfig typechecks must also be a place tests can live, or a
 *  lane's tests silently never run. `scripts/**` matters: S1-S3 and P0.5 all put their
 *  code (and therefore their tests) there. src/index.test.ts asserts this list stays in
 *  step with tsconfig's `include`. */
export const TEST_ROOTS = ['src', 'scripts', 'infra', 'tests'] as const;

/** Node-side tests: everything that is not a rendered component (P0.7). */
export const NODE_TEST_GLOBS = TEST_ROOTS.map((root) => `${root}/**/*.test.ts`);

/**
 * UI tests are `.tsx` only, so the split is a file extension rather than a path. A
 * `src/ui/**` test that needs the filesystem — U1's node:*-purity check reads source
 * text — stays a `.test.ts` and runs under node, where `node:fs` exists.
 */
export const UI_TEST_GLOBS = ['src/ui/**/*.test.tsx'];

export default defineConfig({
  test: {
    // Two environments, one command. The CLI core must keep running under node: giving
    // the whole suite jsdom would let a browser global leak into a kernel or memory
    // module and still pass here, then fail where it matters.
    projects: [
      {
        test: {
          name: 'node',
          // Tests for a lane's own modules live beside them; tests/guards/** holds only
          // the cross-cutting guards (task DAG §2).
          include: NODE_TEST_GLOBS,
          environment: 'node',
        },
      },
      {
        test: {
          name: 'ui',
          include: UI_TEST_GLOBS,
          environment: 'jsdom',
        },
      },
    ],
    // Deliberately NOT passWithNoTests: an empty run means a broken include glob,
    // and that should fail rather than look green.
  },
});
