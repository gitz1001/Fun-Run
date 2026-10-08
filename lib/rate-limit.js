import { dbConfigured, sql, ensureSchema } from './db.js';

/**
 * Per-IP limits that hold across serverless instances.
 *
 * A Map in module scope only counts what one warm instance happens to see, so
 * a burst spread over several instances — or a cold start — walked straight
 * past it. The counters live in Postgres instead, in fixed windows.
 *
 * If the database cannot be reached the in-memory count takes over rather than
 * failing the request: a limiter that is down should not take registration
 * down with it.
 */

const memory = new Map();

function memoryWindow(bucket, key, windowSec) {
  const slot = Math.floor(Date.now() / 1000 / windowSec);
  const id = `${bucket}|${key}|${slot}`;
  if (memory.size > 2000) memory.clear();
  return id;
}

/** Counts one event and returns how many this key has made in the window. */
export async function hit(bucket, key, windowSec) {
  const id = memoryWindow(bucket, key, windowSec);
  const local = (memory.get(id) || 0) + 1;
  memory.set(id, local);
  if (!dbConfigured()) return local;

  try {
    await ensureSchema();
    const q = sql();
    const rows = await q`
      INSERT INTO rate_limits (bucket, key, window_start, count)
      VALUES (${bucket}, ${key},
              to_timestamp(floor(extract(epoch FROM now()) / ${windowSec}::int) * ${windowSec}::int), 1)
      ON CONFLICT (bucket, key, window_start)
      DO UPDATE SET count = rate_limits.count + 1
      RETURNING count`;
    // Old windows are dead weight. Cleared now and then rather than on a timer.
    if (Math.random() < 0.02) {
      await q`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`.catch(() => {});
    }
    return rows[0]?.count ?? local;
  } catch (err) {
    console.error('[rate-limit] falling back to memory:', err.message);
    return local;
  }
}

/** How many events this key has made in the current window, without adding one. */
export async function count(bucket, key, windowSec) {
  const local = memory.get(memoryWindow(bucket, key, windowSec)) || 0;
  if (!dbConfigured()) return local;
  try {
    await ensureSchema();
    const rows = await sql()`
      SELECT count FROM rate_limits
       WHERE bucket = ${bucket} AND key = ${key}
         AND window_start = to_timestamp(floor(extract(epoch FROM now()) / ${windowSec}::int) * ${windowSec}::int)`;
    return rows[0]?.count ?? 0;
  } catch (err) {
    console.error('[rate-limit] falling back to memory:', err.message);
    return local;
  }
}

export async function clear(bucket, key) {
  for (const id of memory.keys()) {
    if (id.startsWith(`${bucket}|${key}|`)) memory.delete(id);
  }
  if (!dbConfigured()) return;
  try {
    await sql()`DELETE FROM rate_limits WHERE bucket = ${bucket} AND key = ${key}`;
  } catch (err) {
    console.error('[rate-limit] could not clear:', err.message);
  }
}

/** Counts the event, and says whether it went over the limit. */
export async function limited(bucket, key, { windowSec, max }) {
  return (await hit(bucket, key, windowSec)) > max;
}

/** Vercel overwrites x-forwarded-for, so its first entry is the real client. */
export const clientIp = (req) =>
  String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

/** For tests. */
export function __resetMemory() { memory.clear(); }
