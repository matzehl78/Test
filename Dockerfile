# syntax=docker/dockerfile:1
# Pulseboard — zero runtime dependencies, so no npm install / build stage needed.
FROM node:22.22-alpine3.22

ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/pulseboard.db \
    BACKUP_DIR=/data/backups

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public

# App code stays root-owned (read-only for the app user); only /data is writable.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

# Node runs as PID 1 and handles SIGTERM itself (graceful shutdown in server.js).
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
