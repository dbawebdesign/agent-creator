# Roster — engineering notes for agents working in this repo

Product spec: `docs/SPEC.md`. Live progress: `.workbench/WORKBENCH.md`.

## Stack
- Next.js **16** App Router (React 19). This is newer than most training data: before using a Next API, read the
  matching guide in `node_modules/next/dist/docs/` (e.g. `01-app/02-guides/authentication.md`). Notable: request
  APIs (`cookies()`, `headers()`, `params`, `searchParams`) are async; `middleware.ts` is now `proxy.ts`.
- TypeScript strict + `noUncheckedIndexedAccess`. Zod **4**. Drizzle ORM + node-postgres. Tailwind **v4** (tokens in
  `src/app/globals.css` `@theme`). Icons: `lucide-react`. Primitives: `radix-ui`, `cmdk`, `sonner`.
  Markdown: `react-markdown` + `remark-gfm` (never `dangerouslySetInnerHTML` for user/agent content).
- Postgres 16 + pgvector at `postgres://roster:roster@localhost:5432/roster` (tests: `roster_test`).

## Layout
- `src/server/db/schema/*` — tables (all tenant rows have `org_id`). `src/server/db/client.ts` → `db()`.
- `src/server/auth/session.ts` (sessions, users, magic links), `src/server/auth/access.ts` (`requireOrg(slug, minRole)`).
- `src/server/services/engine.ts` — the engine contract the UI/API calls. Do not import engine internals from UI.
- `src/server/jobs/queue.ts` — Postgres job queue. `src/worker/` — worker process.
- `src/server/agents/spec.ts` — `AgentSpec` (Architect output / blueprint shape).
- `src/components/ui/*` — design-system primitives. Reuse them; don't restyle ad hoc.
- Routes: Studio (agency) at `/a/[agency]/...`, Portal (client/customer) at `/p/[org]/...`, public API `/api/v1/...`,
  MCP `/api/mcp`, webhooks `/api/webhooks/<provider>`.

## Rules
- Every query on tenant data is scoped by `org_id` resolved from an authorized context. 404 on no access.
- Server Actions: validate input with zod; check role with `requireOrg(slug, "member")` (or stricter) inside the action.
- No secrets in logs. Use `logger` from `src/server/lib/logger.ts`.
- Clients never see token usage or cost. Agency-only views may.
- UI: minimal, calm, one accent. Use tokens (`bg-surface`, `text-ink-3`, `border-line`, `bg-accent` …). Sentence case.
  Every list has an empty state; every async action has pending + success/error feedback.
- **Shared working tree with other agents.** Do not run `git commit`/`git stash`/`git checkout`/`git reset`; the
  lead commits. Do not run `next build` or start another `next dev` — use the shared dev server on
  http://localhost:3000 (restart only if it is down: `cd /home/claude/agent-creator && (npx next dev -p 3000 > /tmp/next-dev.log 2>&1 &)`).
  Don't `npm install` without need; if you must, install one package with an exact version.
- Schema changes: prefer new tables in your own schema file; then `npm run db:generate -- --name <slice>` and
  `npm run db:migrate` (and the same with `DATABASE_URL=postgres://roster:roster@localhost:5432/roster_test`).
- Typecheck with `npx tsc --noEmit`; tests with `npx vitest run tests/<yours>`.
- Demo data: `npm run db:seed` (idempotent reset). Logins: `aj@northbeam.ai` / `roster-demo` (agency owner),
  `dana@brandlord.co` / `roster-demo` (client owner).
- Scripts outside Next (worker, seed, one-off tsx) must run with `tsx --conditions=react-server …` so `server-only`
  imports resolve (the npm scripts already do this). Vitest aliases `server-only` to a shim.
Screens: `node scripts/screens.mjs --as <email> --out <dir> [--themes light,dark] [--viewports desktop,mobile] [--full] <routes…>` (creates a DB session; prints HTTP status and console errors per page).
