# pls

Release automation tool for Deno/TypeScript projects.

## Usage

```bash
# Dry run (default)
pls

# Create release
pls --execute

# Use local storage
pls --storage=local --execute

# Use GitHub storage
pls --storage=github --execute

# Transition to alpha/beta/rc/stable
pls transition alpha --execute
pls transition beta --execute
pls transition stable --execute
```

## Storage Backends

- **Local**: JSON file in `.pls/` directory
- **GitHub**: Uses tags and releases

## What It Does

1. Detects commits since last release
2. Calculates version bump from conventional commits
3. Creates git tags and pushes them
4. Saves release info via storage backend
5. Generates CHANGELOG.md

## Installation

```bash
# Run directly
deno run -A jsr:@dgellow/pls

# Or install globally
deno install -A -n pls jsr:@dgellow/pls/cli
```

## Development

```bash
deno task dev      # Run CLI
deno task test     # Run tests
deno task fmt      # Format code
deno task check    # Type check
```

## License

Elastic License 2.0
