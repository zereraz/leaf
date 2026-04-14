# Docker Deployment Guide

Complete Docker setup for running leaf bot locally and in production.

## Quick Start (Local Testing)

```bash
# 1. Build the image
make build

# 2. Start the bot
make start

# 3. View logs (see QR code for WhatsApp)
make logs

# 4. Stop the bot
make stop
```

## Prerequisites

- Docker Engine 20.10+
- Docker Compose 2.0+
- Make (optional, for convenience commands)

## Configuration

### 1. Environment Variables

Copy your `.env` file (it's already there):

```bash
# Ensure your .env has:
TRANSPORT=whatsapp
WA_OWNER_PHONE=YOUR_PHONE_NUMBER
```

### 2. Privacy Config

Your `privacy.config.ts` is already set up. It will be mounted into the container.

## Local Development

### Build

```bash
# Build fresh image
make build

# Or with Docker Compose directly:
docker compose build --no-cache
```

### Start

```bash
# Start in background
make start

# Or:
docker compose up -d
```

### View Logs

```bash
# Follow logs (important for WhatsApp QR code)
make logs

# Or:
docker compose logs -f
```

### Stop

```bash
make stop

# Or:
docker compose down
```

### Full Reset

```bash
# Remove containers, volumes, and images
make clean
```

## WhatsApp Authentication

### First Run

1. Start the bot: `make start`
2. View logs: `make logs`
3. Scan the QR code with your WhatsApp
4. Authentication is saved to the `wa-auth` volume

### Re-authenticate

If you need to re-scan QR code:

```bash
# Clear auth and restart
make whatsapp-clear
make restart
```

Or manually:

```bash
docker compose down -v  # Remove wa-auth volume
make start             # Fresh start with new QR
```

## Production Deployment

### Option 1: Docker Compose (Single Server)

```bash
# Deploy to production
make prod-deploy

# View production logs
make prod-logs
```

### Option 2: Pre-built Image (Recommended)

1. Build and push to registry:

```bash
# Build
docker build -t your-registry/leaf-bot:latest .

# Push
docker push your-registry/leaf-bot:latest
```

2. On production server, edit `docker-compose.prod.yml`:

```yaml
services:
  leaf:
    image: your-registry/leaf-bot:latest
    # Remove or comment out the build section
```

3. Deploy:

```bash
make prod-deploy
```

## Data Persistence

Data is stored in named volumes:

| Volume | Purpose |
|--------|---------|
| `leaf-data` | Bot logs, state, sessions |
| `wa-auth` | WhatsApp authentication |
| `leaf-pi-home` | Pi agent sessions |

### Backup

```bash
# Backup all data
make backup

# Or manually:
docker run --rm -v leaf-data:/data -v $(pwd)/backups:/backup alpine tar czf /backup/data-$(date +%Y%m%d).tar.gz -C /data .
```

### Restore

```bash
# Stop bot
make stop

# Restore from backup
docker run --rm -v leaf-data:/data -v $(pwd)/backups/20240115:/backup alpine sh -c "cd /data && tar xzf /backup/data.tar.gz"

# Start bot
make start
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs
docker compose logs

# Check environment
docker compose config

# Shell into container
docker compose run --rm leaf sh
```

### Permission Issues

The container runs as non-root user (`nodejs` uid 1001). Ensure volumes have correct permissions:

```bash
# Fix permissions
docker compose run --rm --user root leaf chown -R nodejs:nodejs /app/data /app/wa-auth
```

### WhatsApp Connection Issues

```bash
# Clear auth and restart
make whatsapp-clear
make restart
```

### High Memory Usage

Adjust memory limits in `docker-compose.yml`:

```yaml
deploy:
  resources:
    limits:
      memory: 1G  # Increase if needed
```

## Security

- Container runs as non-root user
- Read-only root filesystem (production)
- Resource limits enforced
- Secrets via environment variables (not in image)
- Privacy config mounted read-only

## Monitoring

### Health Checks

The container includes health checks. View status:

```bash
docker compose ps
```

### Logs

```bash
# Current logs
docker compose logs

# Last 100 lines with follow
docker compose logs -f --tail=100
```

### Resource Usage

```bash
docker stats leaf-bot
```

## Updates

### Update Code

```bash
# Pull latest, rebuild, restart
git pull
make update
```

### Update Dependencies

```bash
# Rebuild with fresh dependencies
make clean
make build
make start
```

## Advanced Usage

### Custom Network

```bash
# Use existing Docker network
docker compose up -d --network=my-network
```

### Multiple Instances

```bash
# Run multiple bots on same host
TRANSPORT=whatsapp WA_OWNER_PHONE=111 docker compose -p leaf1 up -d
TRANSPORT=whatsapp WA_OWNER_PHONE=222 docker compose -p leaf2 up -d
```

### Debug Mode

```bash
# Run with shell instead of bot
docker compose run --rm leaf sh

# Then manually start:
# npm start
```

## All Make Commands

| Command | Description |
|---------|-------------|
| `make build` | Build Docker image |
| `make start` | Start bot |
| `make stop` | Stop bot |
| `make restart` | Restart bot |
| `make logs` | View logs |
| `make shell` | Open container shell |
| `make clean` | Remove everything |
| `make prod-deploy` | Deploy to production |
| `make backup` | Backup data |
| `make status` | Check status |
| `make update` | Update and restart |
