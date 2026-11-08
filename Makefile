.DEFAULT_GOAL := help

PORT = 8805

# ── Help ──────────────────────────────────────────────────────────────────────
.PHONY: help
help:
	@echo ""
	@echo "  make serve      Start dev server → http://localhost:$(PORT)"
	@echo "  make kill       Kill this project's HTTP server"
	@echo "  make catalogue  Validate api/v2/catalogue.json and rebuild api/v1/references.json"
	@echo "  make uploads    Refresh the Meme Vault uploads in the catalogue from memes-site"
	@echo "  make check      Fail if either JSON file is out of date"
	@echo "  make test       Run the catalogue tests"
	@echo ""

# ── Catalogue ─────────────────────────────────────────────────────────────────
.PHONY: catalogue uploads check test
catalogue:
	@node scripts/catalogue.mjs

uploads:
	@node scripts/import-uploads.mjs

check:
	@node scripts/catalogue.mjs --check

test:
	@node --test tests/*.test.mjs

# ── Dev server ────────────────────────────────────────────────────────────────
.PHONY: serve
serve:
	@echo "Serving → http://localhost:$(PORT)"
	@if [ -f ../../scripts/serve.py ]; then python3 ../../scripts/serve.py $(PORT); else python3 -m http.server $(PORT); fi

# ── Kill ──────────────────────────────────────────────────────────────────────
.PHONY: kill
kill:
	@lsof -ti :$(PORT) | xargs kill 2>/dev/null && echo "Stopped server on port $(PORT)" || echo "No server running on port $(PORT)"
