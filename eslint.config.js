import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // `plugins/` is PHP and other languages. `examples/**/*.mjs` are standalone
    // merchant-facing scripts that import the published package rather than the
    // workspace sources, so they sit outside the typed project on purpose.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'plugins/**',
      'examples/**/*.mjs',
      // The published entry point: plain JavaScript that runs the built bundle,
      // so it cannot be part of the typed project.
      'packages/cli/bin/*.js'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The root config files sit outside tsconfig.json's `include`, so let the
        // type-aware rules fall back to a default project for just those two.
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'vitest.config.ts']
        },
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Money is always bigint base units. Catch an accidental Number() on one.
      'no-loss-of-precision': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // A leading underscore marks an argument that exists only to satisfy a
      // signature, such as the fourth parameter express uses to recognise an
      // error handler.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // The session stores implement an async interface over synchronous backends:
    // a Map, and `node:sqlite`, which has no asynchronous API. The methods are
    // `async` on purpose, so that every failure reaches a caller as a rejected
    // promise rather than as a synchronous throw past their `.catch()`. A future
    // Postgres adapter will await for real behind the same interface.
    files: ['**/sessions/store.ts', '**/sessions/*-store.ts'],
    rules: { '@typescript-eslint/require-await': 'off' }
  },
  {
    // Tests deliberately poke at untyped JSON: supertest types `response.body` as
    // `any`, and asserting on a parsed event payload is the point of the test.
    // Type safety in the source is what these rules are for.
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off'
    }
  }
);
