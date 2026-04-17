.PHONY: help install test build ci publish-public publish-public-dry-run

NPM ?= npm

help:
	@printf "Available targets:\n"
	@printf "  make install                Install dependencies with npm ci\n"
	@printf "  make test                   Run the test suite\n"
	@printf "  make build                  Build production artifacts\n"
	@printf "  make ci                     Run the local CI pipeline (install, test, build)\n"
	@printf "  make publish-public-dry-run Run the local CI pipeline and preview the npm publish\n"
	@printf "  make publish-public         Run the local CI pipeline and publish to npm publicly\n"

install:
	$(NPM) ci

test:
	$(NPM) test

build:
	$(NPM) run build

ci: install test build

publish-public-dry-run: ci
	$(NPM) publish --access public --dry-run

publish-public: ci
	$(NPM) publish --access public
