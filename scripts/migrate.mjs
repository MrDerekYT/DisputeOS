#!/usr/bin/env node
// Applies db/migrations/*.sql in order, once each, inside a transaction. `--reset` drops everything first
// (refused in production). Uses DATABASE_URL (or DATABASE_URL_TEST when APP_ENV=test).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import './load-env.mjs';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development';
const url = (env === 'test' && process.env.DATABASE_URL_TEST) || process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env.local, or run `npm run env:setup`.');
  process.exit(1);
}
if (process.argv.includes('--reset') && env === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
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
