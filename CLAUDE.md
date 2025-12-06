# PLS - Engineering Guidelines

## What is PLS?

A release automation tool built with Deno. Detects commits, calculates semantic version bumps,
creates tags and GitHub releases. Uses pluggable storage backends (local JSON or GitHub releases).

## Core Principles (In Order of Priority)

### 1. User Experience First

The user is a developer running `pls` from their terminal. Every output, error, and interaction must
be designed with them in mind.

**Output must be:**

- **Scannable**: Use consistent prefixes (📦, 🔍, ✅, ❌) so users can quickly find what they need
- **Informative**: Show what's happening, what was found, what will change
- **Honest**: Dry-run mode must clearly show what WOULD happen vs what DID happen

**Errors must be:**

- **Actionable**: Tell the user HOW to fix it, not just what went wrong
- **Specific**: Include the actual values that caused the problem
- **Contextual**: Mention what operation was being attempted

```typescript
// BAD: Useless error
throw new Error('Invalid version');

// GOOD: Actionable error with context
throw new PlsError(
  `Invalid version format "${version}". Expected semver like "1.2.3" or "1.2.3-beta.1"`,
  'VERSION_PARSE_ERROR',
  { input: version, expected: 'semver' },
);
```

### 2. Reliability Over Convenience

We refuse fragile quick solutions. Every feature must be engineered to handle edge cases gracefully.

**Forbidden patterns:**

- Regex parsing of human-readable text when structured data is possible
- Assumptions about external state (network, filesystem, git state)
- Race conditions between operations
- Silent failures or swallowed errors

**Required patterns:**

- Structured data with clear delimiters (e.g., `---pls-release---`)
- Explicit error handling with typed errors
- Idempotent operations where possible
- Backwards compatibility with fallback parsing

### 3. Simplicity Over Features

Do one thing well. Resist the urge to add features "while we're at it."

- No configuration files unless absolutely necessary
- No plugins/extensions until core is rock solid
- No optional behaviors that complicate the mental model
- Delete code that isn't pulling its weight

## Architecture

```
src/
├── cli.ts              # Entry point, argument parsing, orchestration
├── cli-pr.ts           # PR subcommand handler
├── cli-transition.ts   # Version transition subcommand
├── types.ts            # Shared types and PlsError class
├── core/
│   ├── detector.ts     # Git commit detection
│   ├── version.ts      # Semantic version calculation
│   ├── release.ts      # Release creation and tagging
│   ├── pull-request.ts # GitHub PR creation
│   ├── transition.ts   # Pre-release version handling
│   └── release-metadata.ts  # Structured commit message format
├── storage/
│   ├── interface.ts    # Storage contract
│   ├── github.ts       # GitHub releases backend
│   ├── local.ts        # Local JSON file backend
│   └── factory.ts      # Storage instantiation
├── manifest/
│   ├── interface.ts    # Manifest contract (deno.json, package.json)
│   ├── deno.ts         # Deno manifest handler
│   ├── node.ts         # Node manifest handler
│   └── factory.ts      # Manifest detection
└── versions/
    └── mod.ts          # .pls/versions.json handling
```

### Key Interfaces

```typescript
// Storage abstraction - the heart of pls
interface Storage {
  getLastRelease(): Promise<Release | null>;
  saveRelease(release: Release): Promise<void>;
  listReleases(): Promise<Release[]>;
}

// Structured error with code for programmatic handling
class PlsError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
```

## Implementation Standards

### Error Messages

Every error must answer: **What happened? Why? How do I fix it?**

```typescript
// Pattern for actionable errors
throw new PlsError(
  `GitHub API rate limit exceeded. ` +
    `Wait ${resetTime} minutes or set GITHUB_TOKEN for higher limits.`,
  'GITHUB_RATE_LIMIT',
  { resetAt: resetTime, authenticated: !!token },
);
```

Common error scenarios to handle explicitly:

- No git repository found → "Run this command from a git repository"
- No commits since last release → "No changes to release (last release: v1.2.3)"
- GitHub token missing → "Set GITHUB_TOKEN env var or use --token flag"
- Network failure → "GitHub API unreachable. Check your connection or use --storage=local"
- Invalid semver → "Version 'x.y' is not valid semver. Use format: major.minor.patch"

### Data Formats

**Commit messages with metadata:**

```
chore: release v1.2.3

---pls-release---
version: 1.2.3
from: 1.2.2
type: minor
---pls-release---
```

**Local storage (.pls/versions.json):**

```json
{
  ".": {
    "version": "1.2.3",
    "sha": "abc123..."
  }
}
```

### Code Style

```typescript
// Explicit types, no inference for function signatures
function calculateBump(commits: Commit[]): BumpType | null {
  // Early returns for edge cases
  if (commits.length === 0) return null;

  // Descriptive variable names
  const hasBreakingChange = commits.some((c) => c.breaking);
  const hasFeature = commits.some((c) => c.type === 'feat');

  // Clear logic flow
  if (hasBreakingChange) return 'major';
  if (hasFeature) return 'minor';
  return 'patch';
}
```

### Testing

Every module needs tests. Test files live next to implementation: `foo.ts` → `foo_test.ts`

```bash
./scripts/test            # Run all tests
deno test -A src/core/    # Run specific directory
```

Test patterns:

- Unit tests for pure logic (version calculation, commit parsing)
- Integration tests with temp directories for file operations
- Mock external APIs (GitHub) for storage tests

## CLI Output Reference

### Successful Release

```
pls

💾 Using storage: github
📌 Last release: v1.2.2 (abc1234)

🔍 Detecting changes...
📝 Found 5 commits

📊 Version bump: 1.2.2 → 1.2.3 (patch)

🔍 DRY RUN MODE (use --execute to create release)

🏷️  Dry run - would create release:
   Version: 1.2.3
   Tag: v1.2.3
   SHA: def5678
```

### No Changes

```
pls

💾 Using storage: local
📌 Last release: v1.2.3 (abc1234)

🔍 Detecting changes...
ℹ️  No changes detected since last release
```

### Error State

```
pls --storage=github

💾 Using storage: github

❌ Error: GitHub token required for github storage
   Set GITHUB_TOKEN environment variable or use --token flag

   Example:
     export GITHUB_TOKEN=ghp_xxxx
     pls --storage=github

   Or use local storage:
     pls --storage=local
```

## Development Commands

```bash
# Setup
./scripts/bootstrap         # Install deno if needed, cache dependencies

# Run CLI
deno run -A src/cli.ts
deno run -A src/cli.ts --help
deno run -A src/cli.ts pr --execute

# Quality checks (ALWAYS use scripts)
./scripts/lint              # Format check + lint + type check
./scripts/format            # Format code
./scripts/test              # Run tests

# CI (runs lint + test)
deno task ci
```

## Decision Log

| Decision                   | Rationale                                                  |
| -------------------------- | ---------------------------------------------------------- |
| Deno over Node             | ESM-first, built-in TypeScript, better tooling             |
| Storage abstraction        | Enables offline mode, testing, different backends          |
| No config files            | Complexity without benefit for MVP; convention over config |
| Structured commit metadata | Reliability over fragile regex parsing                     |
| Git CLI for local ops      | More reliable than libgit2 bindings; GitHub API for remote |
| Dry-run by default         | Safety first; explicit --execute required for mutations    |

## Anti-Patterns (Do Not Do These)

1. **Silent failures**: Never catch and ignore errors. Log warnings at minimum.

2. **Implicit state**: Don't rely on "the user probably ran X first." Check and fail clearly.

3. **String concatenation for structured data**: Use proper serialization.

4. **Optimistic network calls**: Always handle timeout, rate limit, auth failure.

5. **Magic defaults**: If a default matters, document it in --help and output.

6. **Clever code**: Readable > clever. Future you (and AI agents) will thank you.

## Checklist for New Features

Before implementing:

- [ ] Does this serve the user's actual workflow?
- [ ] Can I explain it in one sentence?
- [ ] What error states are possible? How will I communicate them?
- [ ] Does it work offline / with --storage=local?
- [ ] Is it backwards compatible?
- [ ] Did I add tests for happy path AND error cases?

Before merging:

- [ ] `./scripts/lint` passes
- [ ] `./scripts/test` passes
- [ ] Manual test with `--execute` on a test repo
