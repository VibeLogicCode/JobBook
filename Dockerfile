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

FROM mcr.microsoft.com/playwright:v1.57.0-noble AS runner
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
COPY --from=deps /app/node_modules ./migrate_modules
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data/files /data/backups \
    && chown -R pwuser:pwuser /app /data

# Chromium's sandbox needs privileges a container should not have, and the app
# renders only pages it generated itself, over localhost.
USER pwuser

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server.js"]
