import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests for a lane's own modules live beside them; tests/guards/** holds only the
    // cross-cutting guards (task DAG §2).
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Deliberately NOT passWithNoTests: an empty run means a broken include glob,
    // and that should fail rather than look green.
  },
});
