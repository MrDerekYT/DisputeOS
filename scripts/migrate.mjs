#!/usr/bin/env node
// Applies db/migrations/*.sql in order, once each, inside a transaction. `--reset` drops everything first
// (refused in production). Uses DATABASE_URL (or DATABASE_URL_TEST when APP_ENV=test).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { explainPgError, pgConnectionConfig } from './pg-config.mjs';

// A Vercel Preview build (any branch or pull request) must not change a database's schema. Checked before the env
// files load, so only the value Vercel itself sets counts, not one left in .env.local by `vercel env pull`.
if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
  console.log('Preview build: migrations are not applied; they run on the production deploy.');
  process.exit(0);
}
await import('./load-env.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set, so the migrations cannot run. Locally: copy .env.example to .env.local, or run `npm run env:setup`. On a host such as Vercel: add DATABASE_URL to the project environment variables (see docs/DEPLOY-VERCEL.md).');
  process.exit(1);
}
if (process.argv.includes('--reset') && env === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

let client;
try {
  client = new pg.Client(pgConnectionConfig(url));
  await client.connect();
} catch (e) {
  console.error('Could not connect to the database:', explainPgError(e));
  process.exit(1);
}
try {
  if (process.argv.includes('--reset')) {
    await client.query('drop schema if exists public cascade; drop schema if exists app cascade; create schema public;');
    await client.query('grant all on schema public to public');
    console.log('schema reset');
  }
  await client.query('create schema if not exists app');
  await client.query('create table if not exists app.schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await client.query('select name from app.schema_migrations')).rows.map((r) => r.name));
  const dir = path.join(root, 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  let applied = 0;
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    await client.query('begin');
    try {
      // Two deploys building at once must not both apply a migration. The lock is transaction-scoped, so it also
      // works through a transaction-mode connection pooler; whoever waited re-checks before running anything.
      await client.query("select pg_advisory_xact_lock(hashtextextended('disputeos:migrate', 0))");
      if ((await client.query('select 1 from app.schema_migrations where name = $1', [f])).rowCount) {
        await client.query('commit');
        continue;
      }
      await client.query(sql);
      await client.query('insert into app.schema_migrations (name) values ($1)', [f]);
      await client.query('commit');
      console.log('applied', f);
      applied++;
    } catch (e) {
      await client.query('rollback');
      console.error(`FAILED ${f}:`, e.message);
      process.exit(1);
    }
  }
  console.log(applied ? `${applied} migration(s) applied` : 'database is up to date');
} finally {
  await client.end();
}
