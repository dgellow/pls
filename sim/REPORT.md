# Release tool simulation report

Generated 2026-11-13.

| Tool             | Version under test                            |
| ---------------- | --------------------------------------------- |
| pls              | 0.7.3 (working tree at d9bf735)               |
| release-please   | action v5.0.0                                 |
| changesets       | cli 3.0.3, action v2.1.2                      |
| semantic-release | 25.0.9 with changelog, git and github plugins |

## Summary

| Tool             | pass | FAIL | n/a | gap | error |
| ---------------- | ---: | ---: | --: | --: | ----: |
| pls              |   39 |   22 |   0 |   0 |     0 |
| release-please   |   45 |   13 |   3 |   0 |     0 |
| changesets       |   45 |    7 |   9 |   0 |     0 |
| semantic-release |   29 |   13 |  19 |   0 |     0 |

## Lifecycle

| Scenario                                                         | pls  | release-please | changesets | semantic-release |
| ---------------------------------------------------------------- | ---- | -------------- | ---------- | ---------------- |
| Feature released through a squash merge                          | pass | pass           | pass       | pass             |
| Feature released through a merge merge                           | pass | pass           | pass       | pass             |
| Feature released through a rebase merge                          | pass | pass           | pass       | pass             |
| Second release follows the first without a double bump           | pass | pass           | pass       | pass             |
| Breaking change bumps the major version                          | pass | pass           | pass       | **FAIL**         |
| Several changes accumulate into one pending release              | pass | pass           | pass       | n/a              |
| Release notes contain this release only, and match the changelog | pass | pass           | pass       | pass             |

## Human control

| Scenario                                                         | pls      | release-please | changesets | semantic-release |
| ---------------------------------------------------------------- | -------- | -------------- | ---------- | ---------------- |
| Maintainer rewords the release pull request title before merging | **FAIL** | **FAIL**       | pass       | n/a              |
| Maintainer commits a changelog wording fix to the release branch | **FAIL** | **FAIL**       | **FAIL**   | n/a              |
| Maintainer turns the pending release into a beta                 | pass     | pass           | pass       | n/a              |
| Maintainer forces a major release                                | **FAIL** | pass           | pass       | n/a              |
| The chosen version survives a later push                         | **FAIL** | pass           | pass       | n/a              |
| Choosing a version keeps the changelog entry                     | **FAIL** | pass           | pass       | n/a              |
| Beta, another beta, then stable                                  | pass     | **FAIL**       | pass       | n/a              |

## Failure and recovery

| Scenario                                                          | pls      | release-please | changesets | semantic-release |
| ----------------------------------------------------------------- | -------- | -------------- | ---------- | ---------------- |
| Creating the tag fails once with a 502                            | pass     | pass           | pass       | pass             |
| Creating the GitHub Release is denied (403)                       | **FAIL** | pass           | **FAIL**   | **FAIL**         |
| The tag is created but the response is lost                       | pass     | pass           | pass       | **FAIL**         |
| Two pushes in quick succession, older run finishes last           | **FAIL** | **FAIL**       | pass       | n/a              |
| The API rate limit runs out during the release                    | pass     | pass           | pass       | pass             |
| GitHub accepts a request and never answers                        | **FAIL** | **FAIL**       | **FAIL**   | **FAIL**         |
| A read fails once with a 502 while the pending release is updated | pass     | pass           | pass       | n/a              |

## Environment

| Scenario                                              | pls      | release-please | changesets | semantic-release |
| ----------------------------------------------------- | -------- | -------------- | ---------- | ---------------- |
| 600 commits since the last release                    | pass     | pass           | pass       | pass             |
| CI uses the default shallow checkout everywhere       | **FAIL** | pass           | pass       | pass             |
| Non-ASCII text survives three releases                | **FAIL** | pass           | pass       | pass             |
| A changelog larger than 1 MB keeps its history        | **FAIL** | pass           | pass       | pass             |
| A version kept in an executable script keeps its mode | **FAIL** | n/a            | n/a        | n/a              |
| Only the version line of package.json changes         | **FAIL** | **FAIL**       | pass       | **FAIL**         |

## Trust

| Scenario                                                                   | pls      | release-please | changesets | semantic-release |
| -------------------------------------------------------------------------- | -------- | -------------- | ---------- | ---------------- |
| An outside contribution carries release instructions in its commit message | **FAIL** | pass           | pass       | **FAIL**         |
| The release pull request body names a version the tool never offered       | **FAIL** | n/a            | n/a        | n/a              |
| The next version tag already exists on another commit                      | **FAIL** | **FAIL**       | **FAIL**   | **FAIL**         |

## GitHub rules

| Scenario                                                        | pls      | release-please | changesets | semantic-release |
| --------------------------------------------------------------- | -------- | -------------- | ---------- | ---------------- |
| Publish in the same workflow, with only GITHUB_TOKEN            | pass     | pass           | pass       | pass             |
| Publishing fails once; the next push publishes                  | **FAIL** | **FAIL**       | **FAIL**   | **FAIL**         |
| The repository does not let GitHub Actions create pull requests | pass     | pass           | pass       | n/a              |
| A ruleset restricts who can create version tags                 | pass     | pass           | pass       | pass             |
| Immutable releases are enabled                                  | pass     | pass           | pass       | pass             |
| main only accepts changes through pull requests                 | pass     | pass           | pass       | **FAIL**         |

## Edge cases: commits

| Scenario                                                           | pls      | release-please | changesets | semantic-release |
| ------------------------------------------------------------------ | -------- | -------------- | ---------- | ---------------- |
| Breaking change declared in a BREAKING CHANGE footer               | pass     | pass           | n/a        | pass             |
| Breaking change declared in a BREAKING-CHANGE footer               | **FAIL** | pass           | n/a        | **FAIL**         |
| Breaking change declared as type(scope)!                           | pass     | pass           | n/a        | **FAIL**         |
| A commit body mentions "BREAKING CHANGE" in prose                  | **FAIL** | pass           | n/a        | pass             |
| A commit subject contains HTML and comment markers                 | pass     | pass           | pass       | pass             |
| A pull request with two commits is merged with a merge commit      | pass     | **FAIL**       | n/a        | pass             |
| A branch older than the last release is merged with a merge commit | pass     | **FAIL**       | n/a        | pass             |

## Edge cases: versions

| Scenario                     | pls  | release-please | changesets | semantic-release |
| ---------------------------- | ---- | -------------- | ---------- | ---------------- |
| 1.9.0 to 1.10.0, then 1.10.1 | pass | pass           | pass       | pass             |

## Edge cases: files

| Scenario                                                     | pls      | release-please | changesets | semantic-release |
| ------------------------------------------------------------ | -------- | -------------- | ---------- | ---------------- |
| Files with CRLF line endings keep them                       | **FAIL** | **FAIL**       | pass       | pass             |
| A changelog with an introduction keeps it on top             | **FAIL** | pass           | pass       | **FAIL**         |
| The repository has no CHANGELOG.md yet                       | pass     | pass           | pass       | pass             |
| A configured version file has no place for the tool to write | **FAIL** | n/a            | n/a        | n/a              |
| 400 features with long descriptions in one release           | pass     | pass           | pass       | pass             |

## Edge cases: repository state

| Scenario                                                              | pls  | release-please | changesets | semantic-release |
| --------------------------------------------------------------------- | ---- | -------------- | ---------- | ---------------- |
| The release pull request is closed without merging                    | pass | pass           | pass       | n/a              |
| Someone deletes the release branch                                    | pass | pass           | pass       | n/a              |
| The tag of the latest release is deleted                              | pass | **FAIL**       | pass       | pass             |
| A branch has the same name as the next tag                            | pass | pass           | pass       | pass             |
| CHANGELOG.md changes on main while a release is pending               | pass | pass           | pass       | n/a              |
| The release is merged while a newer change has not been processed yet | pass | **FAIL**       | **FAIL**   | n/a              |
| A new feature lands before CI has processed the release merge         | pass | pass           | pass       | n/a              |
| An old workflow run is re-run after the release                       | pass | pass           | **FAIL**   | pass             |
| The project is at 1.0.0 but that version was never tagged             | pass | pass           | pass       | **FAIL**         |

## Edge cases: settings

| Scenario                                                                   | pls  | release-please | changesets | semantic-release |
| -------------------------------------------------------------------------- | ---- | -------------- | ---------- | ---------------- |
| Squash merges take the commit message from the pull request title and body | pass | pass           | pass       | pass             |
| Head branches are deleted automatically after merge                        | pass | pass           | pass       | pass             |
| Workflows use a personal access token                                      | pass | pass           | pass       | pass             |

## Observations

### A feature is reverted before it is released

- **pls**: after a feature and its revert: 1.1.0
- **release-please**: after a feature and its revert: 1.1.0
- **changesets**: after a feature and its revert: 1.1.0
- **semantic-release**: after a feature and its revert: 1.1.1

### A pull request titled "chore" containing a feat commit is squash-merged

- **pls**: after squash-merging a chore PR that contains a feat commit: 1.0.1
- **release-please**: after squash-merging a chore PR that contains a feat commit: nothing pending
- **changesets**: after squash-merging a chore PR that contains a feat commit: nothing pending
- **semantic-release**: after squash-merging a chore PR that contains a feat commit: 1.0.0

### A breaking change on 0.3.0

- **pls**: breaking change on 0.3.0: 0.4.0
- **release-please**: breaking change on 0.3.0: 1.0.0
- **changesets**: breaking change on 0.3.0: 1.0.0
- **semantic-release**: breaking change on 0.3.0: 0.3.0

### The GitHub Release is deleted, the tag stays

- **pls**: the deleted GitHub Release was recreated on the next push
- **release-please**: the deleted GitHub Release was not recreated
- **changesets**: the deleted GitHub Release was not recreated
- **semantic-release**: the deleted GitHub Release was not recreated

### A documentation-only change lands

- **pls**: after a docs change: pending 1.0.1
- **release-please**: after a docs change: none
- **changesets**: after a docs change: none
- **semantic-release**: after a docs change: none

### A chore lands

- **pls**: after a chore: pending 1.0.1
- **release-please**: after a chore: none
- **changesets**: after a chore: none
- **semantic-release**: after a chore: none

### A commit without a conventional prefix lands

- **pls**: after an unconventional commit: pending 1.0.1
- **release-please**: after an unconventional commit: none
- **changesets**: after an unconventional commit: none
- **semantic-release**: after an unconventional commit: none

### Cost of each stage

- **pls**: push with a releasable change: 23 API calls, 10 git requests, 525 ms in 2 run(s); merge
  of the release: 9 API calls, 10 git requests, 389 ms in 2 run(s); re-run with nothing to do: 9 API
  calls, 10 git requests, 409 ms in 2 run(s)
- **release-please**: push with a releasable change: 26 API calls, 0 git requests, 506 ms in 1
  run(s); merge of the release: 15 API calls, 0 git requests, 346 ms in 1 run(s); re-run with
  nothing to do: 10 API calls, 0 git requests, 334 ms in 1 run(s)
- **changesets**: push with a releasable change: 5 API calls, 5 git requests, 3590 ms in 1 run(s);
  merge of the release: 2 API calls, 9 git requests, 1537 ms in 1 run(s); re-run with nothing to do:
  0 API calls, 5 git requests, 466 ms in 1 run(s)
- **semantic-release**: push with a releasable change: 3 API calls, 19 git requests, 1658 ms in 1
  run(s); merge of the release: 0 API calls, 0 git requests, 0 ms in 0 run(s); re-run with nothing
  to do: 1 API calls, 15 git requests, 1266 ms in 1 run(s)

## Failures in detail

### pls

**Maintainer rewords the release pull request title before merging** (`control/edit-pr-title`, FAIL)

```
after the title edit the changelog entry lost the change:
(no section)
```

**Maintainer commits a changelog wording fix to the release branch** (`control/edit-release-branch`,
FAIL)

```
the maintainer's commit on the release branch was discarded without any notice
```

**Maintainer forces a major release** (`control/pick-major`, FAIL)

```
release PR offers no checkbox for 2.0.0. Options:
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->
- [ ] 1.1.0-alpha.0 (alpha) <!-- pls:v:1.1.0-alpha.0:transition -->
- [ ] 1.1.0-beta.0 (beta) <!-- pls:v:1.1.0-beta.0:transition -->
- [ ] 1.1.0-rc.0 (rc) <!-- pls:v:1.1.0-rc.0:transition -->
```

**The chosen version survives a later push** (`control/choice-survives-push`, FAIL)

```
after another push the pending release is 1.1.0, not the chosen 1.1.0-beta.0
```

**Choosing a version keeps the changelog entry** (`control/choice-keeps-changelog`, FAIL)

```
CHANGELOG.md on the release branch has no section for 1.1.0-beta.0
```

**Creating the GitHub Release is denied (403)** (`recovery/release-write-denied`, FAIL)

```
no GitHub Release exists for 1.1.0, and every workflow run reported success
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (19 API calls)
  run-3 Create Release [push] success (7 API calls)
  run-4 Prepare Release [push] success (3 API calls)
```

**Two pushes in quick succession, older run finishes last** (`recovery/overlapping-runs`, FAIL)

```
pending release lost "handle empty input" after overlapping runs:
## 1.1.0

### Features

- add export command

### Chores

- initialize pls
```

**GitHub accepts a request and never answers** (`recovery/api-hangs`, FAIL)

```
2 run(s) were still waiting after 20 s and had to be killed: the tool sets no request timeout
```

**CI uses the default shallow checkout everywhere** (`environment/shallow-checkout`, FAIL)

```
no release pull request was opened, and every workflow run reported success
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (3 API calls)
```

**Non-ASCII text survives three releases** (`environment/unicode`, FAIL)

```
existing changelog line was altered. Lines now containing "caf":
- support naÃÂ¯ve cafÃÂ© Ã¢ÂÂ input
- cafÃÂÃÂ© ÃÂ¢ÃÂÃÂ ÃÂ¯ÃÂ¸ÃÂ ÃÂ¦ÃÂÃÂ¥ÃÂ¦ÃÂÃÂ¬ÃÂ¨ÃÂªÃÂ ÃÂ¢ÃÂÃÂ naÃÂÃÂ¯ve ÃÂ¢ÃÂÃÂquotesÃÂ¢ÃÂÃÂ
```

**A changelog larger than 1 MB keeps its history** (`environment/large-changelog`, FAIL)

```
changelog shrank from 1470963 to 129 bytes and lost its history
```

**A version kept in an executable script keeps its mode** (`environment/executable-version-file`,
FAIL)

```
bin/widget has mode 100644 after the release, was 100755
```

**Only the version line of package.json changes** (`environment/manifest-formatting`, FAIL)

```
16 lines of package.json changed, expected 1:
{
  "name": "widget",
  "version": "1.1.0",
  "files": [
    "dist",
    "src"
  ],
  "scripts": {
    "test": "node test.js"
  }
}
```

**An outside contribution carries release instructions in its commit message**
(`trust/contribution-forces-release`, FAIL)

```
merging the contribution created tag(s) v99.0.0 and 1 release(s), while the files on main say 1.0.0
```

**The release pull request body names a version the tool never offered**
(`trust/tampered-release-pr`, FAIL)

```
the pending release became 9.9.9-evil.1
```

**The next version tag already exists on another commit** (`trust/tag-already-taken`, FAIL)

```
tag v1.1.0 points at 922aedd, the release commit is ed841fc, and every workflow run reported success
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (19 API calls)
  run-3 Create Release [push] success (6 API calls)
  run-4 Prepare Release [push] success (2 API calls)
```

**Publishing fails once; the next push publishes** (`platform/publish-retried`, FAIL)

```
version 1.1.0 is tagged but was published 0 times after the next push
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (19 API calls)
  run-3 Create Release [push] failure (7 API calls)
      publish: curl: (22) The requested URL returned error: 503
  run-4 Prepare Release [push] success (3 API calls)
  run-5 Create Release [push] success (8 API calls)
  run-6 Prepare Release [push] success (19 API calls)
```

**Breaking change declared in a BREAKING-CHANGE footer** (`edge/breaking-hyphen-footer`, FAIL)

```
tag v2.0.0 does not exist. Tags: v1.0.0, v1.0.1
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (19 API calls)
  run-3 Create Release [push] success (6 API calls)
  run-4 Prepare Release [push] success (3 API calls)
```

**A commit body mentions "BREAKING CHANGE" in prose** (`edge/breaking-words-in-prose`, FAIL)

```
tag v1.0.1 does not exist. Tags: v1.0.0, v2.0.0
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (19 API calls)
  run-3 Create Release [push] success (6 API calls)
  run-4 Prepare Release [push] success (3 API calls)
```

**Files with CRLF line endings keep them** (`edge/crlf`, FAIL)

```
package.json has 0 CRLF and 4 bare LF line endings after the release
```

**A changelog with an introduction keeps it on top** (`edge/changelog-preamble`, FAIL)

```
the new entry was placed above the introduction
```

**A configured version file has no place for the tool to write** (`edge/version-file-unmarked`,
FAIL)

```
the version file was left at 1.0.0 in the pending release, and every workflow run reported success
  run-1 Create Release [push] success (4 API calls)
  run-2 Prepare Release [push] success (18 API calls)
  run-3 Create Release [push] success (5 API calls)
  run-4 Prepare Release [push] success (18 API calls)
```

### release-please

**Maintainer rewords the release pull request title before merging** (`control/edit-pr-title`, FAIL)

```
tag v1.1.0 does not exist. Tags: v1.0.0
  run-1 release-please [push] success (26 API calls)
  run-2 release-please [push] success (13 API calls)
```

**Maintainer commits a changelog wording fix to the release branch** (`control/edit-release-branch`,
FAIL)

```
the maintainer's commit on the release branch was discarded without any notice
```

**Beta, another beta, then stable** (`control/prerelease-to-stable`, FAIL)

```
second beta is proposed as 1.1.1-beta.0, expected 1.1.0-beta.1
```

**Two pushes in quick succession, older run finishes last** (`recovery/overlapping-runs`, FAIL)

```
pending release lost "handle empty input" after overlapping runs:
## [1.1.0](http://127.0.0.1:33991/acme/widget/compare/v1.0.0...v1.1.0) (2026-11-13)


### Features

* add export command ([41cb728](http://127.0.0.1:33991/acme/widget/commit/41cb7282adf396ff569211c461ffb26fb911ba96))
```

**GitHub accepts a request and never answers** (`recovery/api-hangs`, FAIL)

```
1 run(s) were still waiting after 20 s and had to be killed: the tool sets no request timeout
```

**Only the version line of package.json changes** (`environment/manifest-formatting`, FAIL)

```
15 lines of package.json changed, expected 1:
{
    "name": "widget",
    "version": "1.1.0",
    "files": [
        "dist",
        "src"
    ],
    "scripts": {
        "test": "node test.js"
    }
}
```

**The next version tag already exists on another commit** (`trust/tag-already-taken`, FAIL)

```
tag v1.1.0 points at 6e6bd55, the release commit is 84a3906, and every workflow run reported success
  run-1 release-please [push] success (26 API calls)
  run-2 release-please [push] success (29 API calls)
```

**Publishing fails once; the next push publishes** (`platform/publish-retried`, FAIL)

```
version 1.1.0 is tagged but was published 0 times after the next push
  run-1 release-please [push] success (26 API calls)
  run-2 release-please [push] failure (16 API calls)
      publish: curl: (22) The requested URL returned error: 503
  run-3 release-please [push] success (12 API calls)
```

**A pull request with two commits is merged with a merge commit** (`edge/merge-commit-two-commits`,
FAIL)

```
"add export command" appears 2 times in the notes:
## [1.1.0](http://127.0.0.1:38853/acme/widget/compare/v1.0.0...v1.1.0) (2026-11-13)


### Features

* add export command ([4f59696](http://127.0.0.1:38853/acme/widget/commit/4f596969219717012d02cb21194dd63c279a68da))
* add export command ([9741b61](http://127.0.0.1:38853/acme/widget/commit/9741b6188d42dfe58fc636019688480e38bd16ed))


### Bug Fixes

* handle empty input ([5a63330](http://127.0.0.1:38853/acme/widget/commit/5a63330ffbf0a84d95e2fa237ded765a822ed192))
```

**A branch older than the last release is merged with a merge commit**
(`edge/old-branch-merged-late`, FAIL)

```
no open release pull request
  run-1 release-please [push] success (26 API calls)
  run-2 release-please [push] success (15 API calls)
  run-3 release-please [push] success (12 API calls)
```

**Files with CRLF line endings keep them** (`edge/crlf`, FAIL)

```
package.json has 1 CRLF and 3 bare LF line endings after the release
```

**The tag of the latest release is deleted** (`edge/tag-deleted`, FAIL)

```
tag v1.1.0 was not restored (files on main say 1.1.0), and every workflow run reported success
  run-1 release-please [push] success (26 API calls)
  run-2 release-please [push] success (15 API calls)
  run-3 release-please [push] success (27 API calls)
```

**The release is merged while a newer change has not been processed yet**
(`edge/merge-before-ci-catches-up`, FAIL)

```
the fix is neither in the 1.1.0 notes nor in a pending release
```

### changesets

**Maintainer commits a changelog wording fix to the release branch** (`control/edit-release-branch`,
FAIL)

```
the maintainer's commit on the release branch was discarded without any notice
```

**Creating the GitHub Release is denied (403)** (`recovery/release-write-denied`, FAIL)

```
no GitHub Release for v1.1.0
  run-1 Release [push] success (5 API calls)
  run-2 Release [push] failure (2 API calls)
      changesets/action: 🦋 changeset v3.0.3
      [?25l◇  Created git tags:
      - v1.1.0
      [?25h::error::Resource not accessible by integration
  run-3 Release [push] success (0 API calls)
```

**GitHub accepts a request and never answers** (`recovery/api-hangs`, FAIL)

```
1 run(s) were still waiting after 20 s and had to be killed: the tool sets no request timeout
```

**The next version tag already exists on another commit** (`trust/tag-already-taken`, FAIL)

```
tag v1.1.0 points at ab55e31, the release commit is 5f1d8d2, and every workflow run reported success
  run-1 Release [push] success (5 API calls)
  run-2 Release [push] success (0 API calls)
```

**Publishing fails once; the next push publishes** (`platform/publish-retried`, FAIL)

```
version 1.1.0 is tagged but was published 0 times after the next push
  run-1 Release [push] success (5 API calls)
  run-2 Release [push] failure (3 API calls)
      publish: curl: (22) The requested URL returned error: 503
  run-3 Release [push] success (0 API calls)
```

**The release is merged while a newer change has not been processed yet**
(`edge/merge-before-ci-catches-up`, FAIL)

```
tag v1.1.0 does not exist. Tags: v1.0.0
  run-1 Release [push] success (5 API calls)
  run-2 Release [push] success (7 API calls)
  run-3 Release [push] success (7 API calls)
```

**An old workflow run is re-run after the release** (`edge/rerun-old-run`, FAIL)

```
re-running old jobs opened a release pull request proposing 1.1.0
```

### semantic-release

**Breaking change bumps the major version** (`lifecycle/breaking`, FAIL)

```
tag v2.0.0 does not exist. Tags: v1.0.0
  run-1 Release [push] success (1 API calls)
```

**Creating the GitHub Release is denied (403)** (`recovery/release-write-denied`, FAIL)

```
no GitHub Release for v1.1.0
  run-1 Release [push] failure (2 API calls)
      semantic-release:   },
        pluginName: [32m'@semantic-release/github'[39m,
        [cause]: [90mundefined[39m
      }
  run-2 Release [push] success (1 API calls)
```

**The tag is created but the response is lost** (`recovery/lost-response`, FAIL)

```
CHANGELOG.md has 2 sections for 1.1.0
```

**GitHub accepts a request and never answers** (`recovery/api-hangs`, FAIL)

```
1 run(s) were still waiting after 20 s and had to be killed: the tool sets no request timeout
```

**Only the version line of package.json changes** (`environment/manifest-formatting`, FAIL)

```
15 lines of package.json changed, expected 1:
{
    "name": "widget",
    "version": "1.1.0",
    "private": true,
    "files": [
        "dist",
        "src"
    ],
    "scripts": {
        "test": "node test.js"
    }
}
```

**An outside contribution carries release instructions in its commit message**
(`trust/contribution-forces-release`, FAIL)

```
merging the contribution created tag(s) v2.0.0 and 1 release(s), while the files on main say 2.0.0
```

**The next version tag already exists on another commit** (`trust/tag-already-taken`, FAIL)

```
tag v1.1.0 points at 28ad62c, the release commit is absent, and every workflow run reported success
  run-1 Release [push] success (3 API calls)
```

**Publishing fails once; the next push publishes** (`platform/publish-retried`, FAIL)

```
version 1.1.0 is tagged but was published 0 times after the next push
  run-1 Release [push] failure (3 API calls)
      semantic-release:   ipcOutput: [],
        pipedFrom: [],
        pluginName: [32m'@semantic-release/exec'[39m
      }
  run-2 Release [push] success (1 API calls)
```

**main only accepts changes through pull requests** (`platform/protected-main`, FAIL)

```
tag v1.1.0 does not exist. Tags: v1.0.0
  run-1 Release [push] failure (1 API calls)
      semantic-release:   ipcOutput: [],
        pipedFrom: [],
        pluginName: [32m'@semantic-release/git'[39m
      }
```

**Breaking change declared in a BREAKING-CHANGE footer** (`edge/breaking-hyphen-footer`, FAIL)

```
tag v2.0.0 does not exist. Tags: v1.0.0, v1.0.1
  run-1 Release [push] success (3 API calls)
```

**Breaking change declared as type(scope)!** (`edge/breaking-scope-bang`, FAIL)

```
tag v2.0.0 does not exist. Tags: v1.0.0
  run-1 Release [push] success (1 API calls)
```

**A changelog with an introduction keeps it on top** (`edge/changelog-preamble`, FAIL)

```
the new entry was placed above the introduction
```

**The project is at 1.0.0 but that version was never tagged** (`edge/first-release-untagged`, FAIL)

```
tag v1.1.0 does not exist. Tags: v1.0.0
  run-1 Release [push] success (3 API calls)
```
