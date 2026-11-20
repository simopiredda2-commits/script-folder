import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/helpers/global-setup.ts'],
    // Nessuna query fuori dalla transazione aperta (D225).
    setupFiles: ['test/helpers/transaction-guard.ts'],
    // Ogni file di prova crea il proprio database temporaneo: possono girare in parallelo.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
