default: check

# Type-check and lint
check:
    bunx tsc --noEmit
    bunx biome check src/

# Run tests
test:
    bun test

# Format code
format:
    bunx biome check --write src/

# Build (placeholder — bun build --compile blocked by Bun #17312)
build:
    @echo "bun build --compile is blocked by Bun #17312 (native .node addons)."
    @echo "Use 'bun install -g' for distribution instead."
