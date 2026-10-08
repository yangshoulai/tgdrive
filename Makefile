PYTHON ?= python

.PHONY: check lint test web-typecheck web-build

check: lint test web-typecheck web-build

lint:
	$(PYTHON) -m ruff check src tests

test:
	PYTHONPATH=src $(PYTHON) -m unittest discover -s tests -v

web-typecheck:
	cd web && node node_modules/typescript/bin/tsc -p tsconfig.app.json

web-build:
	cd web && node build-apps.mjs
