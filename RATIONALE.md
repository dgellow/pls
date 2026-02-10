# Why pls?

## The Problem

Every release tool is married to its ecosystem.

- **semantic-release** needs a plugin per ecosystem (npm, Maven, PyPI, ...), each with its own
  config, edge cases, and maintenance burden.
- **release-please** supports ~10 ecosystems through thousands of lines of format-specific parsing
  (TOML for Rust, XML for Java, YAML for Helm, ...).
- **goreleaser** only does Go.
- **cargo-release** only does Rust.
- **standard-version** only does Node.

Want to release a Go project? A different tool. Python? Another one. Monorepo with mixed languages?
Good luck.

The root cause is that every tool tries to understand and manipulate each ecosystem's manifest
format. When your version lives in `Cargo.toml` (TOML), `pom.xml` (XML), `build.gradle` (Groovy
DSL), `pyproject.toml` (TOML but different schema), `.gemspec` (Ruby), or `package.json` (JSON), you
need a parser for each. And not just any parser -- one that round-trips without destroying comments
and formatting.

This is an enormous amount of complexity for what is fundamentally a simple operation: replacing a
version string.

## The Insight

Version management has two parts:

1. **Tracking the current version** -- what version are we on, what's the next one?
2. **Updating the version in source files** -- writing the new version string somewhere the code can
   use it.

Part 1 is universal. Semver works the same regardless of language. Git tags work the same. Commit
analysis works the same.

Part 2 is where every tool breaks, because each ecosystem stores the version differently. Some don't
store it at all (Go and Swift use git tags exclusively).

## The `@pls-version` Marker

pls solves part 2 with a single mechanism that works in every language: a comment marker.

```typescript
// @pls-version
export const VERSION = '1.2.3';
```

```go
// @pls-version
var Version = "1.2.3"
```

```python
# @pls-version
__version__ = "1.2.3"
```

```ruby
# @pls-version
VERSION = "1.2.3"
```

```xml
<!-- @pls-version -->
<version>1.2.3</version>
```

The rules are simple:

1. pls finds a line containing `@pls-version`
2. On the next line, it replaces the semver string
3. Everything else -- quotes, syntax, surrounding code -- is preserved

No TOML parser. No XML parser. No Groovy DSL parser. No language-specific logic at all. The comment
syntax is the developer's to choose (`//`, `#`, `<!-- -->`, `--`, `(*`, whatever their language
uses). pls doesn't even need to know what language it is.

## What This Enables

One tool for every ecosystem:

| Ecosystem | Manifest detected | Version in manifest? | `@pls-version` works? |
| --------- | ----------------- | -------------------- | --------------------- |
| Deno      | `deno.json`       | Yes (auto-updated)   | Yes                   |
| Node      | `package.json`    | Yes (auto-updated)   | Yes                   |
| Go        | `go.mod`          | No (tags only)       | Yes                   |
| Rust      | `Cargo.toml`      | Yes (TOML)           | Yes                   |
| Python    | `pyproject.toml`  | Yes (TOML)           | Yes                   |
| Java      | `pom.xml`         | Yes (XML)            | Yes                   |
| Ruby      | `.gemspec`        | Yes (Ruby DSL)       | Yes                   |
| Swift     | `Package.swift`   | No (tags only)       | Yes                   |
| C#        | `.csproj`         | Yes (XML)            | Yes                   |
| Any other | --                | --                   | Yes                   |

For JSON manifests (`deno.json`, `package.json`), pls also auto-updates the `version` field as a
convenience -- JSON round-trips cleanly. For everything else, `@pls-version` is the interface.

The version lives where the code actually uses it. Not in a tool-specific config. Not in a manifest
the runtime never reads. In your source code, in a constant your program imports.

## Comparison

|                       | pls                           | semantic-release       | release-please                                 | goreleaser        |
| --------------------- | ----------------------------- | ---------------------- | ---------------------------------------------- | ----------------- |
| Ecosystems            | Any                           | Plugin per ecosystem   | ~10 built-in                                   | Go only           |
| Config files          | None required                 | `.releaserc` + plugins | `release-please-config.json` + `manifest.json` | `.goreleaser.yml` |
| Version source        | `.pls/versions.json` + tags   | Tags + plugin state    | Manifest files                                 | Tags              |
| Version in source     | `@pls-version` (any language) | Plugin-specific        | Ecosystem-specific parsers                     | `ldflags`         |
| Dry-run default       | Yes                           | No                     | N/A (bot)                                      | No                |
| Format parsers needed | None (JSON convenience only)  | Per-plugin             | TOML, XML, YAML, JSON, ...                     | None              |
