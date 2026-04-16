# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# schema.sql is not copied by tsc — place it alongside the compiled migrate.js
# so that dist/db/migrate.js can find it via __dirname-relative path.
RUN cp src/db/schema.sql dist/db/schema.sql

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY world-map.json ./

# mechdata/ and MPBT.MSG are proprietary and gitignored — they cannot be baked
# into the image.  Mount them from the VPS host via volumes (see deploy/).
# The game server will exit at startup if either is missing.

EXPOSE 2000 2001

# Run DB migration (idempotent) then start the ARIES + world TCP servers.
# DATABASE_URL must be set in the container environment.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
