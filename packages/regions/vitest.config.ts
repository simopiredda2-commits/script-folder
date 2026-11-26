import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'regions',
    environment: 'node',
    // Le prove del nucleo e quelle di ogni pacchetto, in `<chiave>/test` (D297).
    include: ['test/**/*.test.ts', '*/test/**/*.test.ts'],
  },
});
