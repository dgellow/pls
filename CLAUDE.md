# PLS - Project Context for AI Implementers

## Project Overview

PLS is a minimal, fast release automation tool built with Deno. It's designed to be a modern
replacement for release-please with a focus on simplicity, reliability, and extensibility through
pluggable storage backends.

## Core Philosophy

- **Minimal MVP**: Start with only detect → version → release
- **Storage First**: Everything flows through a clean storage interface
- **Fast by Default**: Prefer local operations, minimize network calls
- **No Early Optimization**: Build a solid foundation before adding features

We follow the Zig Zen principles (adapted for TypeScript/Deno):

- Communicate intent precisely
- Edge cases matter
- Favor reading code over writing code
- Only one obvious way to do things
- Runtime crashes are better than bugs
- Compile errors are better than runtime crashes
- Incremental improvements
- Avoid local maximums
- Reduce the amount one must remember
- Focus on code rather than style
- Together we serve the users

## Architecture

### Storage Interface (Most Important)

```typescript
interface Storage {
  getLastRelease(): Promise<Release | null>;
  saveRelease(release: Release): Promise<void>;
  listReleases(): Promise<Release[]>;
}
```

Two initial implementations:

- `github.ts`: Uses GitHub tags/releases as source of truth
- `local.ts`: JSON file in `.pls/` directory for speed/offline

### Core Modules

1. **detector.ts**: Find commits since last release
2. **version.ts**: Calculate version bump (major/minor/patch)
3. **release.ts**: Create the actual release

### Tech Stack

- **Runtime**: Deno (latest stable)
- **Language**: TypeScript
- **Package Format**: ESM modules
- **Distribution**: Both Deno module and npm (via dnt)

## Implementation Guidelines

### Code Style

- Use Deno's built-in formatter (`deno fmt`)
- Prefer explicit types over inference
- Keep functions small and focused
- No external dependencies unless absolutely necessary

### Testing

- Write tests alongside implementation
- Use Deno's built-in test runner
- Mock storage for unit tests
- Integration tests for each storage backend

### Error Handling

- Never swallow errors silently
- Provide actionable error messages
- Graceful degradation (especially for GitHub backend)
- Use structured errors with error codes

### Performance

- Batch API requests where possible
- Cache with clear TTL strategies
- Parallel operations when safe
- Progress indicators for long operations

## MVP Scope (Phase 1)

### What's IN:

- Detect commits since last release
- Parse conventional commits for version bump
- Create git tags and save release info to storage backend
- Two storage backends (GitHub, local)
- Basic CLI with --dry-run support

### What's OUT (for now):

- Pull requests
- CHANGELOG files
- Configuration files
- Monorepo support
- Custom commit formats
- Plugins/extensions

## Future Considerations

When adding features later, they should:

- Not require changes to core interfaces
- Be optional/pluggable
- Maintain backward compatibility
- Follow the storage-first pattern

## Development Commands

```bash
# Run the CLI
deno run -A src/cli.ts

# Run tests
deno test -A

# Format code
deno fmt

# Type check
deno check src/mod.ts

# Build npm package (WIP: has dnt compatibility issues)
# deno run -A scripts/build_npm.ts
```

## Key Decisions

1. **Why Deno?**: ESM-first, built-in tooling, TypeScript native, can compile to npm
2. **Why storage backends?**: Flexibility for different workflows, testing, reliability
3. **Why minimal?**: Avoid release-please's complexity, easier to maintain
4. **Why use git CLI?**: For local operations (tags, commits) but not for remote operations

## Common Pitfalls to Avoid

- Don't couple storage logic with business logic
- Don't assume GitHub API is always available
- Don't add features before the core is solid
- Don't make configuration required
- Don't optimize prematurely

## Questions to Ask

Before implementing any feature:

1. Does it require changing the storage interface?
2. Can it be added without touching core modules?
3. Is it actually needed for MVP?
4. Does it make the tool slower or less reliable?

If any answer is problematic, reconsider the approach.
