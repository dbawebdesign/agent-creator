import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export async function runMigrations(url = process.env.DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster") {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("create extension if not exists pgcrypto");
    try {
      await client.query("create extension if not exists vector");
    } catch {
      // pgvector is optional; retrieval falls back to full-text search.
      console.warn("[migrate] pgvector not available; embeddings disabled");
    }
    await migrate(drizzle(client), { migrationsFolder: new URL("../../../drizzle", import.meta.url).pathname });
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log("[migrate] done");
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
