# pls

A minimal, fast, and reliable release automation tool.

## Why?

Release-please is powerful but fragile. It relies entirely on GitHub's API for state management,
making it slow and prone to failures. After maintaining a 300+ change fork at Stainless, we decided
to build something better.

## Philosophy

- **Simple**: Just three commands: detect, version, release
- **Fast**: Local operations by default, network only when necessary
- **Reliable**: Pluggable storage backends, graceful degradation
- **Extensible**: Clean interfaces, easy to add features without breaking core

## How it Works

```bash
# Create a new release (analyzes commits, bumps version, creates GitHub release)
pls

# Dry run to see what would happen
pls --dry-run

# Use local storage (fast, works offline)
pls --storage=local

# Use GitHub storage (release-please compatible)
pls --storage=github
```

## Storage Backends

The key innovation: everything flows through a storage interface.

- **Local**: JSON file in `.pls/` - fast, offline, great for development
- **GitHub**: Uses tags and releases - compatible with existing workflows
- **Future**: S3, Redis, PostgreSQL - whatever you need

## What It Does (MVP)

1. **Detects** commits since last release
2. **Calculates** version bump from conventional commits
3. **Creates** GitHub release with generated notes

That's it. No configuration files, no complex workflows, no surprises.

## What It Doesn't Do (Yet)

- Pull requests (coming in v2)
- CHANGELOG files (coming in v2)
- Monorepos (coming in v3)
- Configuration files (only if needed)

## Design Goals

1. **< 1 second** for typical operations
2. **Zero configuration** for common cases
3. **Clear errors** with recovery steps
4. **Works offline** with local backend
5. **Easy to extend** without breaking changes

## Installation

```bash
# Deno (recommended)
deno install -A https://deno.land/x/pls/cli.ts

# Node.js
npm install -g @stainless/pls

# GitHub Actions
- uses: denoland/setup-deno@v1
- run: deno run -A https://deno.land/x/pls/cli.ts
```

## Architecture

```
Storage Interface
    ├── GitHub Backend (API)
    └── Local Backend (File)
           ↓
    Core Modules
    ├── Detector (commits)
    ├── Version (semver)
    └── Release (publish)
           ↓
         CLI
```

## Contributing

We prioritize:

- Correctness over features
- Performance over flexibility
- Clarity over cleverness

See [CLAUDE.md](./CLAUDE.md) for implementation details.

## License

MIT
