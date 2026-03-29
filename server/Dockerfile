# ==============================================================================
# HeartBeatz API Server — Docker Image
# ==============================================================================
# Lightweight Node.js container for the orchestration layer.
# Serves the touchscreen UI and proxies to the RuView sensing server.

FROM node:20-slim

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy server source
COPY src/ ./src/

# Copy UI assets (mounted via volume in docker-compose, but baked in for standalone)
# The actual UI is at /app/ui via the volume mount

EXPOSE 8080

ENV NODE_ENV=production
ENV HEARTBEATZ_PORT=8080

CMD ["node", "src/index.js"]
