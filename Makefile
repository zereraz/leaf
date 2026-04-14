# Makefile — Convenience commands for Docker operations

.PHONY: help build start stop logs shell clean prod-build prod-deploy

# Default target
help:
	@echo "Leaf Bot Docker Commands:"
	@echo ""
	@echo "Local Development:"
	@echo "  make build         - Build Docker image locally"
	@echo "  make start         - Start bot in background"
	@echo "  make stop          - Stop bot"
	@echo "  make restart       - Restart bot"
	@echo "  make logs          - View logs (follow)"
	@echo "  make shell         - Open shell in running container"
	@echo "  make clean         - Remove containers and volumes"
	@echo ""
	@echo "Production:"
	@echo "  make prod-build    - Build production image"
	@echo "  make prod-deploy   - Deploy to production"
	@echo "  make prod-logs     - View production logs"
	@echo "  make prod-stop     - Stop production"
	@echo ""
	@echo "Maintenance:"
	@echo "  make update        - Pull latest and rebuild"
	@echo "  make status        - Check container status"
	@echo "  make backup        - Backup data volumes"

# ── Local Development ────────────────────────────────────────────────────────

build:
	docker compose build --no-cache

start:
	docker compose up -d
	@echo "Bot started. Run 'make logs' to view logs."

stop:
	docker compose down

restart:
	docker compose restart

logs:
	docker compose logs -f --tail=100

shell:
	docker compose exec leaf sh

clean:
	docker compose down -v --remove-orphans
	docker rmi leaf-leaf 2>/dev/null || true

# ── Production ───────────────────────────────────────────────────────────────

prod-build:
	docker compose -f docker-compose.prod.yml build --no-cache

prod-deploy:
	docker compose -f docker-compose.prod.yml up -d
	@echo "Production bot deployed."

prod-logs:
	docker compose -f docker-compose.prod.yml logs -f --tail=100

prod-stop:
	docker compose -f docker-compose.prod.yml down

prod-shell:
	docker compose -f docker-compose.prod.yml exec leaf sh

# ── Maintenance ──────────────────────────────────────────────────────────────

update:
	git pull
	docker compose build --no-cache
	docker compose up -d

status:
	@docker ps --filter "name=leaf" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

backup:
	@mkdir -p backups/$$(date +%Y%m%d)
	docker run --rm -v leaf-data:/data -v $$(pwd)/backups/$$(date +%Y%m%d):/backup alpine tar czf /backup/data.tar.gz -C /data .
	docker run --rm -v wa-auth:/auth -v $$(pwd)/backups/$$(date +%Y%m%d):/backup alpine tar czf /backup/wa-auth.tar.gz -C /auth .
	@echo "Backup saved to backups/$$(date +%Y%m%d)/"

# ── Utility ──────────────────────────────────────────────────────────────────

lint:
	npm run typecheck

whatsapp-clear:
	docker compose exec leaf node -e "require('./src/whatsapp.js').clearWhatsAppAuth()"
	@echo "WhatsApp auth cleared. Restart bot and scan QR code again."
