# syntax=docker/dockerfile:1
# Multi-stage build for leaf bot

# ── Stage 1: Dependencies ────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

# Install dependencies needed for native modules
RUN apk add --no-cache libc6-compat python3 make g++

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including dev - needed for tsx runtime)
RUN npm ci && npm cache clean --force

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:22-alpine AS production
WORKDIR /app

# Install runtime dependencies for WhatsApp/Baileys
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    curl

# Tell Puppeteer to skip installing Chrome. We'll be using the installed package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy all dependencies (including dev - needed for tsx)
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=nodejs:nodejs /app/package*.json ./

# Copy source code
COPY --chown=nodejs:nodejs . .

# Create data directories
RUN mkdir -p /app/data /app/wa-auth && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port (for health checks or future HTTP API)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "console.log('healthy')" || exit 1

# Start the bot
CMD ["npm", "start"]
