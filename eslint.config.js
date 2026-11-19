// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.tmp-*/**',
      'docs/prototipi/**',
      'sync/**',
      // Worktree temporanei degli agenti: copie del repository, non codice da controllare qui.
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Hook di React solo in cima al componente, mai dopo un'uscita anticipata: altrimenti la
    // pagina cade al secondo disegno («Rendered more hooks than during the previous render»).
    files: ['apps/web/src/**/*.ts', 'apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
  {
    // Regole di prescrizione: i valori stanno nei dati (packages/rules/data), mai nel codice.
    files: ['packages/rules/src/**/*.ts'],
    ignores: ['packages/rules/src/dates.ts'],
    rules: {
      'no-magic-numbers': ['error', { ignore: [0, 1, -1], ignoreArrayIndexes: true }],
    },
  },
  {
    // Nelle prove le risposte HTTP sono JSON non tipizzato: i controlli `no-unsafe-*` non aiutano.
    files: ['**/test/**/*.ts', '**/test/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
