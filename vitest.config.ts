import { defineConfig } from 'vitest/config';

/** Every directory the tsconfig typechecks must also be a place tests can live, or a
 *  lane's tests silently never run. `scripts/**` matters: S1-S3 and P0.5 all put their
 *  code (and therefore their tests) there. src/index.test.ts asserts this list stays in
 *  step with tsconfig's `include`. */
export const TEST_ROOTS = ['src', 'scripts', 'infra', 'tests'] as const;

export default defineConfig({
  test: {
    // Tests for a lane's own modules live beside them; tests/guards/** holds only the
    // cross-cutting guards (task DAG §2).
    include: TEST_ROOTS.map((root) => `${root}/**/*.test.ts`),
    environment: 'node',
    // Deliberately NOT passWithNoTests: an empty run means a broken include glob,
    // and that should fail rather than look green.
  },
});
