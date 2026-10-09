#!/usr/bin/env node
// Minimal forward-only migration runner — Step 1.1 (planning/implementation-plan.md)
// picked this over node-pg-migrate/Prisma migrate because the migrations in
// src/database/migrations are already plain, reviewed SQL files with no
// up/down split; a tool that expects JS/TS migration files with both would
// fight that format rather than fit it. Tracks what's applied in
// public.schema_migrations (not control/tenant — this is tooling metadata,
// not product data). No rollback support: these migrations don't define
// one, matching how they're written and reviewed today.
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'database', 'migrations');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set — copy .env.example to .env and fill it in first.');
    process.exit(1);
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // filenames are zero-padded (000_, 001_, ...) so lexical sort is the intended order

    const { rows: appliedRows } = await client.query('SELECT filename FROM public.schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.filename));
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`Applying ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('OK');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FAILED');
        throw err;
      }
    }

    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
