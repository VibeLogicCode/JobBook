import { sql } from 'drizzle-orm';
import { db } from '@/db/client';

export const dynamic = 'force-dynamic';

/**
 * Container health.
 *
 * It queries the database rather than just returning 200: a process that is
 * listening but cannot reach Postgres is not healthy, and reporting it as
 * healthy is how a broken deployment stays up quietly.
 */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // Deliberately no detail. This route answers without authentication so
    // the container healthcheck can reach it, and a database error message
    // names hosts, roles and sometimes columns.
    console.error('health check failed', error);
    return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
