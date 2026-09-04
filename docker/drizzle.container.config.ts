import { defineConfig } from 'drizzle-kit';

/**
 * Migration config for inside the image.
 *
 * Separate from the repository's drizzle.config.ts because the paths there are
 * relative to a project root that does not exist in the image. These are
 * absolute, so the migrator finds the SQL wherever it is invoked from.
 */
export default defineConfig({
  schema: '/app/src/db/schema/index.ts',
  out: '/app/drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
});
