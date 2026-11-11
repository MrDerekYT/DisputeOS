import pg from 'pg';
import { getEnv } from './env';

// int8 (cents, counts) -> number; numeric -> number; DATE stays a 'YYYY-MM-DD' string (no timezone drift).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);
// timestamptz / timestamp -> ISO-8601 strings (matches our row types and serialises cleanly to client components).
pg.types.setTypeParser(1184, (v) => new Date(v).toISOString());
pg.types.setTypeParser(1114, (v) => new Date(`${v}Z`).toISOString());

export type Param = string | number | boolean | null | Date | string[] | number[] | object | undefined;

/** Minimal query surface handed to feature code. */
export interface Db {
  rows<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]>;
  row<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T | null>;
  run(sql: string, params?: Param[]): Promise<number>;
}

const g = globalThis as unknown as { __dosPool?: pg.Pool };

export function pool(): pg.Pool {
  if (!g.__dosPool) {
    g.__dosPool = new pg.Pool({ connectionString: getEnv().DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
    g.__dosPool.on('error', (e) => console.error('[db] idle client error', e.message));
  }
  return g.__dosPool;
}

export async function closePool() {
  if (g.__dosPool) {
    await g.__dosPool.end();
    g.__dosPool = undefined;
  }
}

function wrap(c: pg.PoolClient): Db {
  // One connection runs one query at a time. Chaining makes `Promise.all([db.rows(..), db.rows(..)])` safe (and avoids
  // pg's "client already executing a query" deprecation) while keeping queries strictly ordered inside the transaction.
  let queue: Promise<unknown> = Promise.resolve();
  const exec = (sql: string, params?: Param[]) => {
    const run = queue.then(() => c.query(sql, params as unknown[]));
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    rows: async (sql, params) => (await exec(sql, params)).rows,
    row: async (sql, params) => (await exec(sql, params)).rows[0] ?? null,
    run: async (sql, params) => (await exec(sql, params)).rowCount ?? 0,
  };
}

async function inTx<T>(setup: ((c: pg.PoolClient) => Promise<void>) | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const c = await pool().connect();
  try {
    await c.query('begin');
    if (setup) await setup(c);
    const out = await fn(wrap(c));
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Tenant-scoped transaction. Row-level security is enforced by PostgreSQL: the transaction runs as the
 * `disputeos_rls` role with `app.user_id` set, so a bug in application code cannot read another tenant's rows.
 * This is the ONLY way feature code should touch tenant data.
 */
export function withTenant<T>(userId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx(async (c) => {
    await c.query('set local role disputeos_rls');
    await c.query("select set_config('app.user_id', $1, true)", [userId]);
  }, fn);
}

/**
 * Privileged (RLS-bypassing) access. Reserved for code that runs before a user context exists or across tenants:
 * sign-in, sign-up, password reset, invitation acceptance, webhooks, scheduled jobs. Keep call sites few and audited.
 */
export function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return inTx(null, fn);
}

export async function systemRows<T = Record<string, unknown>>(sql: string, params?: Param[]): Promise<T[]> {
  return withSystem((db) => db.rows<T>(sql, params));
}
