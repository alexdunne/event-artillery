.PHONY: help install test build check-types clean ci

help:
	@printf "Available targets:\n"
	@printf "  make install       Install dependencies with pnpm\n"
	@printf "  make build         Build all packages (via Turborepo)\n"
	@printf "  make test          Run the test suite across all packages\n"
	@printf "  make check-types   Type-check all packages\n"
	@printf "  make clean         Remove all build artifacts\n"
	@printf "  make ci            Run the local CI pipeline (install, check-types, test, build)\n"

install:
	pnpm install

build:
	pnpm run build

test:
	pnpm run test

check-types:
	pnpm run check-types

clean:
	pnpm run clean

ci: install check-types test build
