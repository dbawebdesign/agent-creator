/**
 * Migrations: `npm run db:migrate` (the compose `migrate` service runs the same thing before web/worker start).
 *
 * 1. A session-level advisory lock, so two deploys (or two replicas booting) never migrate at once; the second
 *    waits, then finds nothing pending.
 * 2. Drizzle's migrator: every pending drizzle/NNNN_*.sql in ONE transaction (all or nothing). Each pending file is
 *    logged before and the batch's duration after.
 * 3. Online steps: drizzle/online/NNNN_*.sql, statement by statement in autocommit, for work that must not run in a
 *    transaction or hold locks for long: CREATE INDEX CONCURRENTLY on big tables and batched backfills. Each file
 *    runs once (recorded in drizzle.__roster_online_steps); its statements must be idempotent, because a deploy that
 *    dies halfway reruns the file. Indexes an interrupted CONCURRENTLY build left INVALID are dropped first.
 *    Writing a new one: put plain DDL in the drizzle-kit migration, then move the big-table CREATE INDEX lines into
 *    drizzle/online/<same tag>.sql as `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import pg from "pg";

/** Arbitrary constant: pg_advisory_lock key shared by every Roster migrator. */
const MIGRATION_LOCK_KEY = 7_412_690_315;

function log(msg: string, extra: Record<string, unknown> = {}) {
  // Plain JSON lines (pino-compatible fields) so deploy logs are greppable; no secrets are ever logged here.
  console.log(JSON.stringify({ level: 30, time: Date.now(), service: "roster-migrate", msg, ...extra }));
}

/** drizzle/ next to the source tree (src/server/db) or next to a bundle (dist/); MIGRATIONS_DIR overrides. */
export function migrationsFolder(): string {
  if (process.env.MIGRATIONS_DIR) return path.resolve(process.env.MIGRATIONS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../../../drizzle"), path.resolve(here, "../drizzle"), path.resolve(process.cwd(), "drizzle")];
  return candidates.find((c) => existsSync(path.join(c, "meta", "_journal.json"))) ?? candidates[0]!;
}

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--.*$/gm, "").trim().length > 0);
}

async function pendingMigrations(client: pg.Client, folder: string) {
  const all = readMigrationFiles({ migrationsFolder: folder });
  const journal = JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> };
  let last = 0;
  try {
    const r = await client.query<{ created_at: string }>(`select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`);
    last = Number(r.rows[0]?.created_at ?? 0);
  } catch {
    last = 0; // first run: the table does not exist yet
  }
  return all.filter((m) => m.folderMillis > last).map((m) => journal.entries.find((e) => e.when === m.folderMillis)?.tag ?? String(m.folderMillis));
}

async function runOnlineSteps(client: pg.Client, folder: string) {
  const dir = path.join(folder, "online");
  if (!existsSync(dir)) return;
  await client.query(`create table if not exists drizzle.__roster_online_steps (name text primary key, finished_at timestamptz not null default now())`);
  const done = new Set((await client.query<{ name: string }>(`select name from drizzle.__roster_online_steps`)).rows.map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const name = file.replace(/\.sql$/, "");
    if (done.has(name)) continue;
    const statements = splitStatements(readFileSync(path.join(dir, file), "utf8"));
    const indexNames = statements.flatMap((s) => [...s.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+"?([\w]+)"?/gi)].map((m) => m[1]!));
    if (indexNames.length) {
      const invalid = await client.query<{ relname: string }>(
        `select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid where not i.indisvalid and c.relname = any($1::text[])`,
        [indexNames],
      );
      for (const { relname } of invalid.rows) {
        log("dropping invalid index left by an interrupted build", { index: relname });
        await client.query(`drop index concurrently if exists "${relname.replace(/"/g, "")}"`);
      }
    }
    log("online step starting", { step: name, statements: statements.length });
    for (const [i, statement] of statements.entries()) {
      const started = Date.now();
      const summary = statement.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim().slice(0, 120);
      await client.query(statement);
      log("online statement done", { step: name, n: i + 1, ms: Date.now() - started, sql: summary });
    }
    await client.query(`insert into drizzle.__roster_online_steps (name) values ($1) on conflict do nothing`, [name]);
    log("online step done", { step: name });
  }
}

export async function runMigrations(url = process.env.DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster") {
  const folder = migrationsFolder();
  const client = new pg.Client({ connectionString: url, application_name: "roster-migrate" });
  await client.connect();
  const started = Date.now();
  let locked = false;
  try {
    // Index builds and backfills can outlast a server-side default; this session only.
    await client.query("set statement_timeout = 0");
    const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock($1) as ok", [MIGRATION_LOCK_KEY]);
    if (!got.rows[0]?.ok) {
      log("another migrator holds the lock; waiting");
      await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    }
    locked = true;
    await client.query("create extension if not exists pgcrypto");
    try {
      await client.query("create extension if not exists vector");
    } catch {
      // pgvector is optional; retrieval falls back to full-text search.
      log("pgvector not available; embeddings disabled");
    }
    const pending = await pendingMigrations(client, folder);
    if (pending.length) {
      for (const tag of pending) log("applying migration", { migration: tag });
      const t = Date.now();
      await migrate(drizzle(client), { migrationsFolder: folder });
      log("migrations applied", { count: pending.length, ms: Date.now() - t });
    } else {
      log("no pending migrations");
    }
    await runOnlineSteps(client, folder);
    log("migrate done", { ms: Date.now() - started });
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  runMigrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(JSON.stringify({ level: 50, time: Date.now(), service: "roster-migrate", msg: "migrate failed", err: err instanceof Error ? err.message : String(err) }));
      process.exit(1);
    });
}
