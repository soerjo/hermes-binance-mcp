FROM oven/bun:1-alpine

WORKDIR /app

# Install dependencies first so Docker can cache this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

RUN addgroup -S -g 1000 mcp && adduser -S -u 1000 -G mcp mcp
USER mcp

ENV MCP_TRANSPORT=sse \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8811 \
    LOG_LEVEL=INFO \
    SCAN_TOP_N=15 \
    SCAN_INTERVAL=4h \
    DEFAULT_LEVERAGE=5 \
    RISK_REWARD=2.0

EXPOSE 8811

# Dedicated /health endpoint — the SSE stream itself never completes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8811/health || exit 1

CMD ["bun", "run", "src/index.ts"]
