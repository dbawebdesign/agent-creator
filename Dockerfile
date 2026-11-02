# syntax=docker/dockerfile:1.7
# Targets: `web` (Next.js standalone server) and `worker` (bundled worker + migrator, production deps only).
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next standalone build + esbuild bundles: dist/worker.mjs, dist/migrate.mjs, dist/worker-health.mjs
RUN npm run build && npm run build:worker

# Web: Next.js standalone server
FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r roster && useradd -r -g roster roster
COPY --from=build --chown=roster:roster /app/.next/standalone ./
COPY --from=build --chown=roster:roster /app/.next/static ./.next/static
COPY --from=build --chown=roster:roster /app/public ./public
USER roster
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node is the direct child of tini (compose `init: true`), so SIGTERM reaches the server.
CMD ["node", "server.js"]

# Worker + migrations: no TypeScript at runtime, no devDependencies.
#   worker:  node --conditions=react-server dist/worker.mjs   (default CMD; drains on SIGTERM for up to 30s)
#   migrate: node --conditions=react-server dist/migrate.mjs  (advisory-locked; run before web/worker start)
FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production ROSTER_PROCESS=roster-worker
RUN groupadd -r roster && useradd -r -g roster roster
COPY --from=prod-deps --chown=roster:roster /app/node_modules ./node_modules
COPY --from=build --chown=roster:roster /app/package.json ./package.json
COPY --from=build --chown=roster:roster /app/dist ./dist
COPY --from=build --chown=roster:roster /app/drizzle ./drizzle
USER roster
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "dist/worker-health.mjs"]
# Never `npm run worker`: npm swallows SIGTERM and the worker never drains.
CMD ["node", "--conditions=react-server", "dist/worker.mjs"]
