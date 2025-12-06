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

Within any pre-release stage, regular `pls --execute` increments the build number (e.g., alpha.0 ->
alpha.1).

## Pull Request Workflow

Create release PRs with selectable version options:

```bash
# Create/update a release PR (dry run)
pls pr

# Create the PR
pls pr --execute

# Sync PR when user changes selection
pls pr sync --pr=123
```

### How It Works

1. `pls pr --execute` creates a PR with version options in the description
2. User selects desired version by checking a checkbox
3. GitHub workflow runs `pls pr sync --pr=123` to apply the selection
4. On merge, `pls --storage=github --execute --pr=123` creates the release and comments

### PR Description Format

The PR description includes a version selection block in a collapsible section:

```markdown
<details>
<summary>Version Selection</summary>

<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
- [ ] 1.3.0-beta.0 (beta) <!-- pls:v:1.3.0-beta.0:transition -->
- [ ] 1.3.0-rc.0 (rc) <!-- pls:v:1.3.0-rc.0:transition -->
<!-- pls:options:end -->

</details>
```

The current selection is displayed as text (no checkbox to avoid double-click issues).
Alternatives have checkboxes - checking one triggers a sync workflow.

### Single Commit Principle

The release PR always has exactly ONE commit. When the selection changes:

1. Branch is reset to base
2. Fresh commit is created with new version
3. Branch is force-pushed
4. PR title and description are updated
5. Comment is posted noting the change

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
