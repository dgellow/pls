# Changelog

## 0.6.1

### Bug Fixes

- preserve quote style when updating @pls-version files

## 0.6.0

### â ï¸ Breaking Changes

- â ï¸ BREAKING: complete rewrite following design.md architecture

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
