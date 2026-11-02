#!/usr/bin/env node
/**
 * Screenshot harness for critics and builders.
 *   node scripts/screens.mjs --as aj@northbeam.ai --out .workbench/screens/round1 /a/northbeam /a/northbeam/clients
 * Options: --as <email> (creates a DB session directly), --themes light,dark, --viewports desktop,mobile, --full
 * Prints one line per screenshot plus any console errors / non-2xx responses seen on the page.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { createRequire } from "node:module";
const { chromium } = createRequire(import.meta.url)("playwright");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const as = opt("as", null);
const out = opt("out", ".workbench/screens");
const themes = opt("themes", "light").split(",");
const viewports = opt("viewports", "desktop").split(",");
const base = opt("base", "http://localhost:3000");
const full = flag("full");
const routes = args.length ? args : ["/"];
const VIEW = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

mkdirSync(out, { recursive: true });

let token = null;
if (as) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://roster:roster@localhost:5432/roster" });
  await client.connect();
  const u = await client.query("select id from users where lower(email) = lower($1)", [as]);
  if (!u.rows[0]) throw new Error(`no user ${as}`);
  token = randomBytes(32).toString("base64url");
  await client.query(
    "insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')",
    [u.rows[0].id, createHash("sha256").update(token).digest("hex")],
  );
  await client.end();
}

const browser = await chromium.launch();
for (const theme of themes) {
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: VIEW[vp], colorScheme: theme, deviceScaleFactor: vp === "mobile" ? 2 : 1 });
    if (token) await ctx.addCookies([{ name: "roster_session", value: token, url: base }]);
    const page = await ctx.newPage();
    const problems = [];
    page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text().slice(0, 200)}`));
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
    page.on("response", (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url().replace(base, "")}`));
    for (const route of routes) {
      problems.length = 0;
      const name = (route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "_") || "root") + `-${theme}-${vp}`;
      const file = path.join(out, `${name}.png`);
      try {
        const res = await page.goto(base + route, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout(400);
        await page.screenshot({ path: file, fullPage: full });
        console.log(`${res?.status()} ${route} → ${file}${problems.length ? `\n   ! ${problems.join("\n   ! ")}` : ""}`);
      } catch (e) {
        console.log(`ERR ${route}: ${e.message.split("\n")[0]}`);
      }
    }
    await ctx.close();
  }
}
await browser.close();
