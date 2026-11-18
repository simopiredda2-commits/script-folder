import { defineConfig } from 'drizzle-kit';

// Genera le migrazioni SQL versionate in migrations/ a partire dallo schema in src/db/schema.
// Le migrazioni si applicano con `pnpm db:migrate` (src/db/migrate-cli.ts), non con drizzle-kit.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  casing: 'snake_case',
});
