# Changelog

Version changed from 0.7.0-alpha.3 to 0.7.0

## 0.7.0-alpha.3

#### â ï¸ Breaking Changes

- test breaking change

This is the body of the breaking change commit.
It explains why this is breaking and what users need to do.<br>
Migration steps:
1. Update your config file
2. Run the migration script
3. Verify everything works

#### Features

- **changelog:** show commit body in PR changelog <details><summary>Details</summary>
  Breaking changes show body directly since they're important.
  Non-breaking commits use collapsible &lt;details&gt; section.<br>
  GitHub markdown quirks:
  - &lt;details&gt; must be on same line as list item
  - No empty lines inside - use &lt;br&gt; instead
  </details>

- **changelog:** show commit body in PR changelog <details><summary>Details</summary>
  Breaking changes show body directly since they're important.
  Non-breaking commits use collapsible &lt;details&gt; section.<br>
  GitHub markdown quirks:
  - &lt;details&gt; must be on same line as list item
  - No empty lines inside - use &lt;br&gt; instead
  </details>

- **changelog:** show commit body in PR changelog <details><summary>Details</summary>
  Breaking changes show body directly since they're important.
  Non-breaking commits use collapsible &lt;details&gt; section.
  </details>


#### Bug Fixes

- more github quirks
- github markdown is annoying
- correct heading for changeset labels

#### CI

- pin Deno to 2.5.x for publish workflow <details><summary>Details</summary>
  Deno 2.6.0 has a bug that causes x86_64-apple-darwin cross-compilation
  to fail with "Writing binary bytes: No such file or directory".<br>
  Fix is merged in https://github.com/denoland/deno/pull/31575 and will
  ship in 2.6.1.
  </details>


## 0.7.0-alpha.2

### Chores

- **ci:** update workflows
- **ci:** update workflows
- **ci:** update workflows
- **ci:** update workflows

## 0.7.0-alpha.1

### Features

- json output
- manifest bootstrap via PR

Version changed from 0.6.1 to 0.7.0-alpha.0

## 0.6.1

### Bug Fixes

- preserve quote style when updating @pls-version files

## 0.6.0

### ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Breaking Changes

- ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ BREAKING: complete rewrite following design.md architecture

### Features

- complete implementation with tests and missing features
- add backend abstraction and fix versionFile preservation
- export VERSION constant from main module
- add version_info.ts with pls-version magic comment
- add version.ts file sync with magic comment detection

### Bug Fixes

- sync version to 0.5.2 across all manifests
- align CI workflows with new pls CLI design
- update CI workflow paths after codebase restructure
- address code review issues
- add version file sync to PR creation flow
- improve version file sync feature

### Code Refactoring

- clean up dead code and fix duplicated logic
- add dependency injection for GitHubBackend in ReleasePullRequest
- unify release file operations with backend abstraction

### Documentation

- fix inconsistencies in design.md
- add implementation details to design
- comprehensive system design
- add self-healing model for pls release
- add Release Tags section with annotated tag metadata format
- comprehensive system design
- rename ARCHITECTURE.md to design.md
- add target architecture design

### Tests

- add integration tests for LocalGit client and workflows
- add git traversal benchmark script

### wip

- dependency injection refactoring for ReleasePullRequest

### Styles

- format CLAUDE.md
