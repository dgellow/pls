# Changelog

## 0.8.0

### ⚠️ Breaking Changes

- do not let an older prep run overwrite a newer release PR
- refuse a version tag that already points at another commit
- stop the release when the configured version file cannot be updated
- detect breaking changes from the footer, not from words in the body

### Features

- read the GitHub API base URL from GITHUB_API_URL

### Bug Fixes

- say on the release PR when commits pushed to its branch are discarded
- end release notes at the release commit when completing a release later
- give every GitHub request a time limit
- keep the mode of files that a release commit rewrites
- change only the version value in JSON manifests
- keep a changelog's introduction above new entries
- **sim:** kill a hung step's processes without relying on `timeout`
- make a version chosen in the release PR hold, and accept only real choices
- fetch missing history in a shallow clone instead of finding no changes
- release what .pls/versions.json says, not what a commit message claims
- fail the run when the GitHub Release cannot be created
- read files from GitHub as UTF-8, and above 1 MB

### Documentation

- list release-branch.ts in the architecture overview
- add the simulation report

### Tests

- add release scenarios for pls and three other release tools
- add a simulated GitHub and GitHub Actions

### CI

- do not run the simulation on pls's own release PR
- build the simulation report in CI instead of committing it

## 0.7.3

### Bug Fixes

- self-heal missing GitHub Releases when tag already exists

## 0.7.2

### Bug Fixes

- strip commit bodies from CHANGELOG.md to avoid deno fmt conflicts
- pre-1.0 breaking changes bump minor, not major

### Code Refactoring

- make workflows VCS-agnostic with LocalRepo/CodeHost interfaces
- extract manifest logic into domain/manifest.ts

### Tests

- add second release step to all e2e tests

## 0.7.1

### Bug Fixes

- **sync:** detect prerelease-to-stable as transition <details><summary>Details</summary>
  determineBumpType returned 'patch' when going from prerelease to stable
    (e.g., 1.3.0-rc.0 to 1.3.0). Now correctly returns 'transition' when
    either version contains a prerelease suffix.
</details>

- more github quirks
- **release:** get commits since previous tag, not all history

Version changed from 0.7.0-alpha.3 to 0.7.0

## 0.7.0-alpha.3

#### ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ ÃÂÃÂ¯ÃÂÃÂ¸ÃÂÃÂ Breaking Changes

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

### ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Breaking Changes

- ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¯ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ¸ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ BREAKING: complete rewrite following design.md architecture

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
