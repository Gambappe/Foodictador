/**
 * The deploy guard: **the relay image's build context must contain everything `tsc` needs.**
 *
 * `infra/relay/Dockerfile` runs `npm run build` inside the image, and `npm run build` starts
 * with `tsc` over tsconfig's `include` — which covers root-level `*.config.ts`. The build
 * stage copies root files by name, so a config file added at the root, or an import added
 * to a file that references one, compiles on every laptop and fails only inside the image:
 *
 *   src/index.test.ts(6,60): error TS2307: Cannot find module '../vitest.config.js'
 *
 * That is what happened. `vitest.config.ts` was never copied, `src/index.test.ts` imports it
 * for the toolchain invariants, and `fly deploy` died at the build step — discovered while
 * setting up the demo, on a Dockerfile that had been committed and reviewed. Local `npm run
 * build`, `npm test` and `npm run lint` all pass in that state, which is precisely why this
 * needs a guard rather than a habit: the only signal is a container build nobody runs until
 * deploy day.
 *
 * Asserted at the source level, against the Dockerfile text, so it fails in CI in seconds
 * rather than after a multi-minute remote build with a stage in front of it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dockerfile = readFileSync(new URL('../../infra/relay/Dockerfile', import.meta.url), 'utf8');

/** The build stage only — the runtime stage deliberately copies nothing but `dist/`. */
const buildStage = dockerfile.slice(0, dockerfile.indexOf('AS runtime'));

/**
 * Only the COPY directives, as token lists. Matching against the raw text would pass on a
 * filename that appears in a comment — including a comment explaining why the file must be
 * copied, which is exactly the shape this file's own header is in.
 */
const copiedTokens = new Set(
  buildStage
    .split('\n')
    .filter((line) => /^COPY\s/.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1)),
);

describe('the relay image build context', () => {
  it('copies every root-level *.config.ts that tsconfig compiles', () => {
    const rootConfigs = readdirSync(repoRoot).filter((name) => name.endsWith('.config.ts'));
    // A sanity floor: if this list is empty the glob broke, and an empty list would make
    // the assertion below vacuously true.
    expect(rootConfigs.length).toBeGreaterThan(0);
    for (const config of rootConfigs) {
      expect(
        copiedTokens.has(config) || copiedTokens.has(`${config.replace(/\.ts$/, '')}.ts*`),
        `${config} is compiled by tsconfig but no COPY line in the build stage names it`,
      ).toBe(true);
    }
  });

  it('copies every directory tsconfig compiles', () => {
    // `include` in tsconfig.json. Kept literal rather than parsed: the point is to fail when
    // the two lists diverge, and a parser that follows a rename silently would not.
    for (const dir of ['src', 'scripts', 'infra', 'tests']) {
      expect(copiedTokens.has(dir), `tsconfig includes ${dir}/ but no COPY line names it`).toBe(
        true,
      );
    }
  });

  it('runs the relay through the entrypoint that fixes volume ownership', () => {
    // A fly.io volume mounts root-owned over the image's chowned directory, so the relay —
    // running as `node` — cannot write its snapshot, and a failed snapshot write is a failed
    // mutation (P0.8). Every confession would 500 while the machine reported healthy.
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/relay-entrypoint.sh"]');
    expect(dockerfile).toContain('CMD ["node", "dist/infra/relay/main.js"]');
    // And the image must NOT pin itself to a non-root user: the entrypoint needs root to
    // chown, and drops to `node` itself.
    expect(dockerfile).not.toMatch(/^USER /m);
  });
});
