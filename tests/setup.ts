process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster_test";
(process.env as Record<string, string>).NODE_ENV = "test";

// Many suites truncate tenants. Refuse to run against anything that isn't clearly a throwaway test database.
const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, "");
if (!/(^|_)(test|ci|sec\w*|tmp|scratch)(_|$)/i.test(dbName)) {
  throw new Error(`Refusing to run tests against database "${dbName}": point TEST_DATABASE_URL at a *_test or *_ci database.`);
}
