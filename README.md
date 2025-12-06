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
```

## Version Transitions

Move through pre-release stages without analyzing commits:

```bash
# Start an alpha cycle (bumps minor by default)
pls transition alpha --execute

# Progress through stages
pls transition beta --execute      # 1.2.0-alpha.5 -> 1.2.0-beta.0
pls transition rc --execute        # 1.2.0-beta.2 -> 1.2.0-rc.0
pls transition stable --execute    # 1.2.0-rc.1 -> 1.2.0

# Control the version bump when starting a new cycle
pls transition alpha --major --execute    # 1.2.3 -> 2.0.0-alpha.0
pls transition alpha --minor --execute    # 1.2.3 -> 1.3.0-alpha.0 (default)
pls transition alpha --patch --execute    # 1.2.3 -> 1.2.4-alpha.0
```

### Transition Flow

```
stable (1.2.3)
    |
    v  [transition alpha --minor]
alpha (1.3.0-alpha.0) --> alpha.1 --> alpha.2 ...
    |
    v  [transition beta]
beta (1.3.0-beta.0) --> beta.1 --> beta.2 ...
    |
    v  [transition rc]
rc (1.3.0-rc.0) --> rc.1 ...
    |
    v  [transition stable]
stable (1.3.0)
```

Within any pre-release stage, regular `pls --execute` increments the build number (e.g., alpha.0 -> alpha.1).

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
