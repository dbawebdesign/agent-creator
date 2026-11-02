process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster_test";
process.env.NODE_ENV = "test";
