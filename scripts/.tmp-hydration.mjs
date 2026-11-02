import pg from "pg";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
const { chromium } = createRequire(import.meta.url)("playwright");
const base = "http://localhost:3000";
const client = new pg.Client({ connectionString: "postgres://roster:roster@localhost:5432/roster" });
await client.connect();
const u = await client.query("select id from users where lower(email)=lower($1)", [process.env.AS ?? "dana@brandlord.co"]);
const token = randomBytes(32).toString("base64url");
await client.query("insert into sessions (user_id, token_hash, expires_at) values ($1,$2, now() + interval '1 hour')", [u.rows[0].id, createHash("sha256").update(token).digest("hex")]);
await client.end();
const browser = await chromium.launch();
const ctx = await browser.newContext({ timezoneId: "Europe/Berlin" });
await ctx.addCookies([{ name: "roster_session", value: token, url: base }]);
const page = await ctx.newPage();
for (const path of process.argv.slice(2)) {
  const errs = [];
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && errs.push(m.text().slice(0, 600)));
  await page.goto(base + path, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  console.log(path, JSON.stringify(errs, null, 1));
  page.removeAllListeners("console");
}
await browser.close();
