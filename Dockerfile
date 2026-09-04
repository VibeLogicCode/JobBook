# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Contractor quote system.
#
# Playwright's own image is the base: it already carries Chromium and the
# hundred-odd system libraries the browser needs. Installing those onto a plain
# node:22-slim by hand is the single most common way a PDF route works in
# development and fails in production with a blank page and no error.
# ---------------------------------------------------------------------------

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The browser binary comes from the base image of the runner stage, so this
# stage must not spend 300MB downloading a second copy.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# next build reads no database: every page is force-dynamic, because a quote
# rendered at build time would be a quote frozen at build time.
RUN npm run build

# The tag MUST match the playwright version in package-lock.json exactly
# (1.62.1 today). Playwright refuses to launch a browser build it did not
# ship with, and the error surfaces only when the first PDF is requested --
# long after the image looked fine.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# The standalone output carries its own minimal node_modules.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Migrations run at boot, so the migration files and drizzle-kit have to be in
# the image -- standalone tracing does not know about SQL the app never imports.
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build /app/src/db ./src/db
COPY --from=build /app/src/lib ./src/lib
COPY --from=build /app/scripts ./scripts
# tsx resolves the @/ alias from tsconfig, so the seed script needs it present.
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json
# The full dependency tree, merged OVER the standalone one, for boot-time
# migrations and the optional demo seed.
#
# It has to sit at /app/node_modules rather than in a directory of its own.
# Node resolves a bare import relative to the FILE doing the importing, so
# /app/scripts/seed.ts and everything under /app/src look for drizzle-orm in
# /app/node_modules and nowhere else -- no cwd, NODE_PATH or tsconfig setting
# changes that. Standalone's traced tree carries only what the server itself
# imports, which is why the seed and the migrator need this.
COPY --from=deps /app/node_modules ./node_modules
COPY docker/drizzle.container.config.ts ./drizzle.container.config.ts
# Backup prerequisites. pg_dump refuses to dump a server NEWER than itself, so
# the client major version is pinned to the one the db service runs -- an
# unpinned client is a backup that silently stops working the day Postgres is
# upgraded. age encrypts the dump to a public key whose private half lives off
# this machine; mountpoint (util-linux) is how the USB destination is verified
# before anything is written to it; curl posts the dead-man's-switch ping.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-client-16 age util-linux curl \
    && rm -rf /var/lib/apt/lists/*

COPY docker/backup.sh docker/restore.sh docker/backup-loop.sh /usr/local/bin/
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/backup.sh \
      /usr/local/bin/restore.sh /usr/local/bin/backup-loop.sh \
    && mkdir -p /data/files /data/backups /data/config \
    && chown -R pwuser:pwuser /app /data

# Chromium's sandbox needs privileges a container should not have, and the app
# renders only pages it generated itself, over localhost.
USER pwuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
