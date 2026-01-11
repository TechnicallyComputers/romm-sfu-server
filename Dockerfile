# syntax=docker/dockerfile:1

# Build deps (mediasoup is a native module)
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# Puppeteer is not required to run the SFU server; skip Chromium download by default.
# If you actually need Puppeteer in-container, set PUPPETEER_SKIP_DOWNLOAD=0 at build time.
ARG PUPPETEER_SKIP_DOWNLOAD=1
ENV PUPPETEER_SKIP_DOWNLOAD=${PUPPETEER_SKIP_DOWNLOAD}

# Install toolchain for native deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .


# Runtime image
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

# Keep the runtime lean; Chromium isn't needed for the SFU itself.
ENV PUPPETEER_SKIP_DOWNLOAD=1

# Copy app + built node_modules
COPY --from=deps /app /app

# Security: run as the non-root node user
USER node

# Signaling (HTTP + Socket.IO)
EXPOSE 3001/tcp

# WebRTC media (WebRtcServer default)
EXPOSE 20000/udp
EXPOSE 20000/tcp

CMD ["npm", "start"]
