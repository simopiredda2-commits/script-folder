import { defineConfig } from 'vitest/config';

/**
 * Prove della dimostrazione nel browser (D223). Restano fuori da `pnpm test` perché vogliono la
 * dimostrazione costruita (`pnpm --filter @mmg/demo build`); nella CI hanno un lavoro loro, con
 * Chromium, WebKit e Firefox.
 */
export default defineConfig({
  test: {
    name: 'dimostrazione',
    environment: 'node',
    include: ['prove/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
