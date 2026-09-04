import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Under Vitest, connect to TEST_DATABASE_URL.
 *
 * Not a convenience. Every database suite truncates tables in `beforeEach`, so
 * a client that only ever read DATABASE_URL would point the whole suite at the
 * development database and empty it on the first run.
 */
const url = process.env.VITEST ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
if (!url) {
  throw new Error(process.env.VITEST ? 'TEST_DATABASE_URL is not set' : 'DATABASE_URL is not set');
}

const queryClient = postgres(url, { max: 10 });
export const db = drizzle(queryClient);
export { queryClient };
