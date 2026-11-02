# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

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
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]

# Worker + migrations: full source with tsx (jobs, scheduler, channel delivery)
FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production ROSTER_PROCESS=roster-worker
RUN groupadd -r roster && useradd -r -g roster roster
COPY --from=deps --chown=roster:roster /app/node_modules ./node_modules
COPY --chown=roster:roster . .
USER roster
CMD ["npm", "run", "worker"]
