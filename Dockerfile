FROM python:3.11-slim

WORKDIR /app

# curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY client.py analysis.py risk.py server.py ./

# Non-root user
RUN useradd -m -u 1000 mcp
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

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf --max-time 3 http://localhost:8811/sse -o /dev/null || exit 1

CMD ["python", "server.py"]
