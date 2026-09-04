import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * The database client, connected lazily.
 *
 * Lazily, because `next build` evaluates every route module to collect page
 * data, with no environment loaded. A connection built at module scope threw
 * "DATABASE_URL is not set" during the build of a page that only ever reads the
 * database at request time.
 *
 * Under Vitest the URL comes from TEST_DATABASE_URL. That is not a
 * convenience: database suites truncate tables in `beforeEach`, so a client
 * that only knew DATABASE_URL would empty the development database on the
 * first run.
 */
function resolveUrl(): string {
  const url = process.env.VITEST ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
  if (!url) {
    throw new Error(process.env.VITEST ? 'TEST_DATABASE_URL is not set' : 'DATABASE_URL is not set');
  }
  return url;
}

let connection: { client: postgres.Sql; db: PostgresJsDatabase } | null = null;

function connect() {
  connection ??= (() => {
    const client = postgres(resolveUrl(), { max: 10 });
    return { client, db: drizzle(client) };
  })();
  return connection;
}

/**
 * A proxy rather than the client itself, so importing this module costs
 * nothing and the first query is what opens the socket. Every call site keeps
 * using `db` exactly as if it were the Drizzle instance.
 */
export const db: PostgresJsDatabase = new Proxy({} as PostgresJsDatabase, {
  get(_target, property, receiver) {
    return Reflect.get(connect().db as object, property, receiver);
  },
});

/** Ends the pool. Scripts need this; the server never does. */
export async function closeDb(): Promise<void> {
  if (!connection) return;
  await connection.client.end();
  connection = null;
}
