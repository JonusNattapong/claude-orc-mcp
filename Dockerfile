# ──────────────────────────────────────────────
# clew-orc broker — Docker image
# ──────────────────────────────────────────────
# Build:    docker build -t clew-orc-broker .
# Run:      docker run -p 7899:7899 clew-orc-broker
# With db:  docker run -v clew-orc-data:/data -p 7899:7899 clew-orc-broker
# ──────────────────────────────────────────────

FROM oven/bun:1.3 AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .

# ──────────────────────────────────────────────

FROM oven/bun:1.3-slim

WORKDIR /app

# CA certs for HTTPS (MCP server needs them)
RUN apt-get update -qq && apt-get install -y -qq ca-certificates procps netcat-openbsd && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

EXPOSE 7899

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s \
  CMD sh -c "nc -z 127.0.0.1 7899 || exit 1"

ENV CLEW_ORC_PORT=7899
ENV CLEW_ORC_DB=/data/clew-orc.db

ENTRYPOINT ["bun", "broker.ts"]
