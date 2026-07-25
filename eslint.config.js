import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The task DAG's §1 engineering rules are enforced here rather than by review:
 * no `any`, no non-null assertions, no silent catch, and a pure kernel that cannot
 * import I/O. A rule in this file is worth more than a sentence in a document.
 *
 * Type-aware rules are scoped to TypeScript files because they need a tsconfig project,
 * and this config file itself is plain JavaScript outside that project.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/*.mjs'] },

  js.configs.recommended,

  {
    // `.tsx` included (P0.7): without it the UI lane's files fall through to the plain
    // JS config, which cannot parse TSX — and a parse error is reported as one lint
    // problem per file, so a whole lane can look "almost clean" while being unchecked.
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // §1: "TypeScript strict, no `any`, no non-null `!`."
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // §1: "No silent catch." An empty block swallows the error entirely.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Surfaces forgotten awaits, which in this codebase means an unverified write.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  {
    // §1: "The kernel is pure." src/kernel/** may not reach for I/O or other lanes.
    files: ['src/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', '**/memory/**', '**/llm/**', '**/cli/**', '**/ui/**'],
              message:
                'src/kernel/** must stay pure: no I/O, no clock, no other lanes. Pass values in instead.',
            },
          ],
        },
      ],
    },
  },

  {
    // The UI runs in a browser; a node: import there is a build error waiting to happen.
    // `.test.ts` under src/ui is exempt (P0.7): it runs under the node project, and U1's
    // purity check has to read the source text it is asserting about. Rendered tests are
    // `.test.tsx`, run under jsdom, and stay covered.
    files: ['src/ui/**/*.ts', 'src/ui/**/*.tsx'],
    ignores: ['src/ui/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: 'src/ui/** must not import node: modules.' }] },
      ],
    },
  },

  // Plain JS in the repo root (this config) gets syntax linting only.
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
);
