# pls Design

## Mission

Automate semantic versioning releases. Read git history, calculate versions, update files, create releases.

---

## Branch Strategies

### Strategy A: Simple (main only)

```
main ──●──●──●──●──●──●──●──●──
              │              ↑
              └─ pls-release ┘
```

- Commits land on `main`
- Release PR: `pls-release` → `main`
- Default, works for most projects

### Strategy B: Next branch (Stainless pattern)

```
next ──●──●──●──●──●──●──●──●
              │
              └─ pls-release ─┐
                              ↓
main ─────────────────────────●
```

- Commits land on `next` (development)
- Release PR: `pls-release` → `main` (production)
- After merge: `next` rebased on `main`
- Clean separation of released vs upcoming

---

## Actors & Triggers

**No webhooks.** Everything is CLI or CI.

| Workflow | Trigger | Runner |
|----------|---------|--------|
| `pls prep` | Manual, or CI on push to baseBranch | Developer CLI or CI |
| `pls sync` | CI on `pull_request.edited` event | CI only |
| `pls release` | CI on **every push to targetBranch** | CI only |
| `pls` (local) | Manual | Developer CLI |

### Self-Healing via Continuous Release

`pls release` runs on **every push to main**, not just PR merges:

```yaml
on:
  push:
    branches: [main]
```

This provides **automatic recovery** from failures:

1. PR merged → versions.json = 1.2.3
2. CI runs `pls release` → **tag creation fails** (network error)
3. User doesn't notice, pushes unrelated commit
4. CI runs `pls release` again → tag v1.2.3 still missing → **creates it**

No special recovery logic. The normal path handles failures.

---

## Manifests

| File | Content | Updated By | When |
|------|---------|------------|------|
| `deno.json` | `{ "version": "1.2.3" }` | pls prep | In release PR |
| `.pls/versions.json` | `{ ".": { "version": "1.2.3" } }` | pls prep | In release PR |
| `CHANGELOG.md` | Release notes | pls prep | In release PR |
| `src/version.ts` | `export const VERSION = "1.2.3"` | pls prep | In release PR (optional) |
| `.pls/config.json` | Configuration | Developer | Manual |

### No SHA in versions.json

**The chicken-egg problem:** We can't know the final SHA until after merge (squash/rebase create new SHAs).

**Solution:** Don't store SHA. Derive it from tags.

```
versions.json: { "version": "1.2.3" }
                      │
                      ▼
         Look up tag v1.2.3 → get SHA
```

- **versions.json** = source of truth for "what is current version"
- **Tag** = source of truth for "what SHA is that version"
- Tag created post-merge by `pls release`, when real SHA is known

### Spurious tag protection

If someone manually creates `v4.0.0` before it's released:

```
Tags: v1.2.3, v4.0.0 (spurious)
versions.json: { "version": "1.2.3" }
```

pls reads versions.json → "1.2.3" → looks up `v1.2.3` → ignores `v4.0.0`.

We don't scan tags. We look up specific tags based on versions.json.

---

## Release Tags

pls creates **annotated tags** with structured metadata in the message.

### Tag Message Format

```
Release v1.2.3

## Changes
- feat: add new feature
- fix: resolve bug

---pls-release---
version: 1.2.3
from: 1.2.2
type: minor
---pls-release---
```

**Human-readable content above** (changelog, visible in `git show v1.2.3`).
**Structured metadata below** (machine-parseable, same format as commit messages).

### Why Annotated Tags?

Annotated tags store:
- Tag name
- Tagger name & email
- Timestamp
- **Message** (arbitrary text, no size limit)
- Commit SHA it points to

This metadata lets us:
1. **Verify a tag is a pls release** — check for `---pls-release---` marker
2. **Extract release info** — parse version, from, type
3. **Show changelog** — human-readable content in `git show`

### Verifying Release Tags

```typescript
function isPlsReleaseTag(tagMessage: string): boolean {
  return tagMessage.includes('---pls-release---');
}

function parseTagMetadata(tagMessage: string): ReleaseMetadata | null {
  // Reuse existing parseReleaseMetadata() from release-metadata.ts
  return parseReleaseMetadata(tagMessage);
}
```

### Finding Last Release SHA

```typescript
async function findLastReleaseSha(version: string): Promise<string | null> {
  const tag = `v${version}`;

  // 1. Check if tag exists
  const tagSha = await git.getTagSha(tag);
  if (!tagSha) {
    // Tag missing — previous release may have failed
    // This is NOT an error, just a warning (self-heals on next pls release)
    console.warn(`Tag ${tag} not found (release may have failed)`);
    // Fallback: search for version-change commit
    return await git.findCommitByVersion(version);
  }

  // 2. Verify it's a pls release tag
  const message = await git.getTagMessage(tag);
  if (!isPlsReleaseTag(message)) {
    // Tag exists but wasn't created by pls — treat as suspicious
    console.warn(`Tag ${tag} exists but is not a pls release tag`);
    // Fallback: search for version-change commit
    return await git.findCommitByVersion(version);
  }

  // 3. Return the SHA the tag points to
  return tagSha;
}

// Fallback: find commit that introduced this version
async function findCommitByVersion(version: string): Promise<string | null> {
  // git log -S "version" --format="%H" -- .pls/versions.json | head -1
  const sha = await git.searchLog(version, '.pls/versions.json');
  return sha;
}
```

**Why fallback instead of error?**
- Tag missing = previous `pls release` failed
- But `pls prep` can still work with fallback SHA
- `pls release` on next push will create the missing tag
- Keep things moving, don't block on transient failures

### Consistency with Commit Messages

Same `---pls-release---` delimiter used in:
- Release commit messages (existing)
- Release tag messages (new)

Reuse `parseReleaseMetadata()` for both.

---

## Configuration

```json
// .pls/config.json (optional - convention over configuration)
{
  "baseBranch": "next",           // where commits land (default: main)
  "targetBranch": "main",         // where releases merge to (default: main)
  "releaseBranch": "pls-release", // PR branch name
  "versionFile": "src/version.ts" // optional TypeScript version file
}
```

---

## The Two Worlds

**Local execution**: Developer runs `pls` in terminal.
- Read: filesystem
- Write: filesystem → git commit → git tag
- History: git log

**Remote execution**: CI runs `pls prep`, `pls sync`, `pls release`.
- Read: GitHub Contents API (or local git for history)
- Write: staged in memory → Git Data API (tree → commit → ref)
- History: local git

**Fundamental tension:** Local writes are incremental, remote writes are atomic.

---

## Core Operations

| Operation | Type | Description |
|-----------|------|-------------|
| Detect | Pure | What commits since last release? |
| Calculate | Pure | What's the new version? |
| Build | Pure | What files change, with what content? |
| Commit | I/O | Create commit with changes |
| Point | I/O | Update branch/tag to commit |
| Release | I/O | Create GitHub Release (optional) |
| PR | I/O | Create/update pull request |

---

## Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                           CLI                                │
│         Parse args, route to workflow, format output         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Workflows                             │
│   LocalRelease    PRCreate    PRSync    PRRelease           │
│         (Orchestration: call services, call clients)         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Domain Services                          │
│                       (Pure Logic)                           │
│                                                              │
│  • calculateBump(commits, version) → VersionBump            │
│  • parseCommits(log) → Commit[]                             │
│  • buildReleaseFiles(state, bump) → Map<path, content>      │
│  • generateChangelog(bump, commits) → string                │
│  • generatePRBody(bump, changelog) → string                 │
│  • parseVersionSelection(body) → Selection                  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   Infrastructure Clients                     │
│                         (All I/O)                            │
├────────────────────────────┬────────────────────────────────┤
│         LocalGit           │         GitHubClient           │
│                            │                                │
│  • readFile                │  • readFile                    │
│  • getCommitsSince         │  • commit                      │
│  • commit                  │  • pointBranch                 │
│  • pointBranch             │  • createTag                   │
│  • createTag               │  • findPR / getPR / createPR   │
│  • getTagSha               │  • updatePR                    │
│                            │  • createGitHubRelease         │
│  (filesystem + git CLI)    │  (GitHub API)                  │
└────────────────────────────┴────────────────────────────────┘
```

---

## Key Design Principles

### 1. Branch is a parameter, not configuration

A commit exists independent of branches. A branch is just a pointer.

```typescript
// Wrong: backend configured per-branch (needs factory)
const backend = new GitHubBackend({ targetBranch: 'pls-release' });
await backend.commit(msg);

// Right: branch is operation parameter (no factory)
const sha = await client.commit(files, msg);
await client.pointBranch('pls-release', sha);
await client.pointBranch('other-branch', sha);  // Same commit!
```

### 2. SHA derived from tags, not stored

- versions.json stores version only
- SHA looked up from tag `v{version}`
- Tag created post-merge when real SHA is known
- Solves chicken-egg problem with squash/rebase merges

### 3. Platform capabilities vs pls domain

**Platform capabilities** (GitHubClient):
- readFile, commit, pointBranch, createTag
- findPR, createPR, updatePR
- createGitHubRelease (optional enhancement)

**pls domain** (workflows + domain services):
- "What's the current version?" → read versions.json
- "What SHA is that version?" → look up tag
- "What files need to change?" → pure logic

---

## Client Interfaces

### LocalGit

```typescript
interface LocalGit {
  // Reading
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;

  // Git history
  getCommitsSince(sha: string | null): Promise<Commit[]>;
  getTagSha(tag: string): Promise<string | null>;
  getHeadSha(): Promise<string>;

  // Writing
  commit(files: Map<string, string>, message: string): Promise<string>;
  pointBranch(name: string, sha: string): Promise<void>;
  createTag(name: string, sha: string): Promise<void>;
  push(ref: string): Promise<void>;
}
```

### GitHubClient

```typescript
interface GitHubClient {
  // Reading
  readFile(path: string, ref?: string): Promise<string | null>;
  fileExists(path: string, ref?: string): Promise<boolean>;

  // Committing (atomic: files → tree → commit)
  commit(files: Map<string, string>, message: string): Promise<string>;

  // Refs (branch as PARAMETER, not config)
  pointBranch(name: string, sha: string): Promise<void>;
  createTag(name: string, sha: string): Promise<void>;

  // PRs
  findPR(branch: string): Promise<PR | null>;
  findMergedPR(branch: string): Promise<PR | null>;
  getPR(number: number): Promise<PR>;
  createPR(options: PROptions): Promise<PR>;
  updatePR(number: number, options: PROptions): Promise<void>;

  // GitHub Releases (optional, platform-specific)
  createGitHubRelease(tag: string, notes: string): Promise<void>;
}
```

---

## Workflows

### 1. pls prep (Create/Update Release PR)

**Trigger:** Developer CLI or CI on push to baseBranch

```
┌─────────────────────────────────────────────────────────────┐
│ 1. READ STATE                                               │
│    • versions.json → current version "1.2.3"                │
│    • Tag v1.2.3 → release SHA (or search commit if no tag)  │
│    • Commits since release SHA                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. COMPUTE (pure)                                           │
│    • Parse commits → bump type (minor)                      │
│    • Calculate version → "1.3.0"                            │
│    • Build file contents (manifests, changelog)             │
│    • Generate PR body (version options, changelog)          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. WRITE (if --execute)                                     │
│    • Create commit with file changes                        │
│    • Point pls-release branch to commit                     │
│    • Create or update PR                                    │
└─────────────────────────────────────────────────────────────┘
```

**UX - Dry run:**
```
$ pls prep

📦 pls prep

Repository: dgellow/pls
Base: next → Target: main
Current version: 1.2.3 (from versions.json)
Release point: v1.2.3 (abc1234)

Commits since v1.2.3:
  feat: add version file sync
  fix: handle missing manifest
  chore: update dependencies

Version bump: 1.2.3 → 1.3.0 (minor)

Files to update:
  deno.json            1.2.3 → 1.3.0
  .pls/versions.json   1.2.3 → 1.3.0
  CHANGELOG.md         (prepend release notes)
  src/version.ts       1.2.3 → 1.3.0

DRY RUN — use --execute to create PR
```

**UX - Execute:**
```
$ pls prep --execute

📦 pls prep

Version bump: 1.2.3 → 1.3.0 (minor)

Creating commit... ✓
Updating branch pls-release... ✓
Creating pull request... ✓

✅ Release PR: https://github.com/dgellow/pls/pull/42

Next steps:
  1. Review the PR
  2. Optionally select different version
  3. Merge when ready
```

---

### 2. pls sync (Sync PR after version selection change)

**Trigger:** CI on `pull_request.edited` event

```
┌─────────────────────────────────────────────────────────────┐
│ 1. READ PR STATE                                            │
│    • Get PR body → parse selected version                   │
│    • Get PR title → extract current version                 │
│    • Compare: same? → exit (no-op)                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if different)
┌─────────────────────────────────────────────────────────────┐
│ 2. COMPUTE                                                  │
│    • Build file contents for selected version               │
│    • Generate updated PR body                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. WRITE                                                    │
│    • Create commit with new files                           │
│    • Force-update PR branch                                 │
│    • Update PR title and body                               │
└─────────────────────────────────────────────────────────────┘
```

**UX:**
```
$ pls sync --pr=42

📦 pls sync

PR #42: chore: release v1.3.0
Selection changed: 1.3.0 → 2.0.0

Updating files for v2.0.0... ✓
Updating branch... ✓
Updating PR... ✓

✅ PR synced to v2.0.0
```

**How it knows PR number:**
- CI: From event payload (`github.event.pull_request.number`)
- CLI: `--pr=42` or auto-detect (find open PR from pls-release branch)

---

### 3. pls release (Ensure current version is released)

**Trigger:** CI on **every push to targetBranch** (not just PR merges)

```
┌─────────────────────────────────────────────────────────────┐
│ 1. READ CURRENT STATE                                       │
│    • Read versions.json → current version "1.2.3"           │
│    • Check if tag v1.2.3 exists                             │
│    • Check if GitHub Release exists                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. EARLY EXIT (idempotent)                                  │
│    • Tag exists + Release exists → "Already released" exit 0│
│    • Nothing to do = success, not error                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if tag missing)
┌─────────────────────────────────────────────────────────────┐
│ 3. FIND RELEASE POINT                                       │
│    • Search for commit that set version to 1.2.3            │
│    • git log -S "1.2.3" -- .pls/versions.json | head -1     │
│    • Or use HEAD if versions.json just changed              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. CREATE RELEASE ARTIFACTS                                 │
│    • Create annotated tag v{version} → release commit SHA   │
│    • Create GitHub Release with changelog (if missing)      │
│    • Handle "already exists" gracefully (concurrent runs)   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if using next branch)
┌─────────────────────────────────────────────────────────────┐
│ 5. SYNC BRANCHES (optional)                                 │
│    • Rebase next on main, or merge main into next           │
└─────────────────────────────────────────────────────────────┘
```

**Key behaviors:**
- **Idempotent:** If already released, exits successfully (not error)
- **Self-healing:** Finds and creates missing tag even if original CI failed
- **Concurrent-safe:** "Tag already exists" → treat as success

**UX - Already released:**
```
$ pls release

📦 pls release

Version: 1.3.0
Tag v1.3.0 exists ✓
GitHub Release exists ✓

Already released. Nothing to do.
```

**UX - Creating release:**
```
$ pls release

📦 pls release

Version: 1.3.0
Tag v1.3.0 missing
Finding release commit... abc1234

Creating tag v1.3.0... ✓
Creating GitHub Release... ✓

✅ Released v1.3.0
   https://github.com/dgellow/pls/releases/tag/v1.3.0
```

**UX - Self-healing (previous failure):**
```
$ pls release

📦 pls release

Version: 1.3.0
Tag v1.3.0 missing (release may have failed previously)
Finding release commit... abc1234

Creating tag v1.3.0... ✓
Creating GitHub Release... ✓

✅ Released v1.3.0 (recovered)
```

---

### 4. pls (Local release, no PR)

**Trigger:** Developer runs `pls` for direct release

```
┌─────────────────────────────────────────────────────────────┐
│ 1. DETECT & COMPUTE (same as prep)                          │
│    • Find release point, get commits, calculate bump        │
│    • Build file contents                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. LOCAL OPERATIONS                                         │
│    • Write files to filesystem                              │
│    • git add + git commit                                   │
│    • git tag v{version}                                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if --push)
┌─────────────────────────────────────────────────────────────┐
│ 3. PUSH                                                     │
│    • git push origin {branch}                               │
│    • git push origin v{version}                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if --github-release)
┌─────────────────────────────────────────────────────────────┐
│ 4. GITHUB RELEASE (optional)                                │
│    • Create via API                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Complete Release Lifecycle (PR Flow)

```
Developer                    GitHub                     CI
────────                    ──────                     ──
    │                           │                       │
    │ push to next              │                       │
    │──────────────────────────▶│                       │
    │                           │ push event            │
    │                           │──────────────────────▶│
    │                           │                       │ pls prep --execute
    │                           │◀──────────────────────│
    │                           │ PR created            │
    │                           │                       │
    │                           │ User edits PR         │
    │                           │ (selects v2.0.0)      │
    │                           │ pull_request.edited   │
    │                           │──────────────────────▶│
    │                           │                       │ pls sync --pr=N
    │                           │◀──────────────────────│
    │                           │ Branch updated        │
    │                           │                       │
    │ Merges PR                 │                       │
    │──────────────────────────▶│                       │
    │                           │ pull_request.closed   │
    │                           │ (merged=true)         │
    │                           │──────────────────────▶│
    │                           │                       │ pls release
    │                           │◀──────────────────────│
    │                           │ Tag + Release created │
    │                           │                       │
```

---

## CI Configuration

### GitHub Actions

```yaml
# .github/workflows/pls-prep.yml
name: Prepare Release
on:
  push:
    branches: [next]  # or [main] for simple strategy

jobs:
  prep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for commit detection
      - run: pls prep --execute
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```yaml
# .github/workflows/pls-sync.yml
name: Sync Release PR
on:
  pull_request:
    types: [edited]
    branches: [main]

jobs:
  sync:
    if: startsWith(github.head_ref, 'pls-release')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: pls sync --pr=${{ github.event.pull_request.number }}
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

```yaml
# .github/workflows/pls-release.yml
name: Create Release
on:
  push:
    branches: [main]  # Every push, not just PR merges

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pls release --execute
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

**Why every push?** Self-healing. If tag creation fails once, next push fixes it.
Most runs will be no-ops ("Already released"), which is cheap and fast.

---

## Version Selection in PR

PR body contains selectable version options:

```markdown
## Release 1.3.0

...changelog...

<details>
<summary>Version Selection</summary>

<!-- pls:options -->
- [ ] 2.0.0 (major - breaking changes)
- [x] 1.3.0 (minor - new features) ← selected
- [ ] 1.2.4 (patch - bug fixes only)
- [ ] 1.3.0-beta.1 (prerelease)
<!-- pls:options:end -->

</details>
```

User checks different box → saves PR → CI runs `pls sync` → branch updated.

---

## Failure Recovery & Idempotency

### Idempotency Matrix

| Operation | Idempotent | On Retry |
|-----------|------------|----------|
| Read files | ✅ Yes | Same result |
| Read commits | ✅ Yes | Same result |
| Compute version/files | ✅ Yes | Same result |
| Create commit | ❌ No | New commit (safe, old orphaned) |
| Update branch ref | ✅ Yes | Same SHA = no-op |
| Create PR | ✅ Yes | If exists → update instead |
| Update PR | ✅ Yes | Same content = no-op |
| Create tag | ✅ Yes | If exists → skip |
| Create GitHub Release | ✅ Yes | If exists → skip |

### Failure Scenarios

**Scenario 1: GitHub fails mid-commit creation**
```
Create blob ✓
Create tree ✓
Create commit ✗ (network error)
```
→ Retry. Orphaned blobs/trees are harmless (GitHub GCs them).

**Scenario 2: Commit created but branch not updated**
```
Create commit ✓ (sha: xyz789)
Update branch ✗ (network error)
```
→ Retry `pls prep`. New commit created, branch updated. Old commit orphaned (harmless).

**Scenario 3: Branch updated but PR not created**
```
Update branch ✓
Create PR ✗ (network error)
```
→ Retry `pls prep`. Finds no PR, creates it. Branch already correct.

**Scenario 4: PR merged but tag not created**
```
PR merged ✓
Create tag ✗ (network error)
```
→ **Self-heals on next push.** `pls release` runs on every push to main.
→ Next unrelated commit triggers CI → tag created automatically.
→ Or: manual `pls release --execute` also works.

**Scenario 5: Tag created but GitHub Release not created**
```
Create tag ✓
Create release ✗ (network error)
```
→ **Self-heals on next push.** Tag exists (skip), release created.

**Scenario 6: Concurrent `pls release` runs**
```
Job A: Check tag → missing
Job B: Check tag → missing
Job A: Create tag ✓
Job B: Create tag → "already exists"
```
→ Job B treats "already exists" as success, not error.

**All failures are recoverable automatically via self-healing.**
**No manual intervention required for transient failures.**

---

## What Dies (Current → Target)

| Current Abstraction | Fate |
|---------------------|------|
| `Storage` interface | Gone. Version from versions.json, SHA from tag. |
| `Manifest` classes | Absorbed into `buildReleaseFiles`. Just JSON parsing. |
| `versions/mod.ts` | Absorbed into domain services. |
| `FileBackend` / `CommitBackend` | Replaced by `LocalGit` / `GitHubClient`. |
| Backend factories | Gone. Branch is a parameter. |
| `ReleasePullRequest` | Split into workflows + `GitHubClient`. |
| `ReleaseManager` | Split into workflows + domain services. |
| SHA in versions.json | Gone. Derived from tags. |

---

## Directory Structure (Target)

```
src/
├── cli/
│   ├── main.ts           # Entry point, arg parsing
│   ├── prep.ts           # pls prep command
│   ├── sync.ts           # pls sync command
│   ├── release.ts        # pls release command
│   └── output.ts         # Formatting, colors, dry-run display
│
├── workflows/
│   ├── local-release.ts  # pls (local release)
│   ├── pr-create.ts      # pls prep (create/update PR)
│   ├── pr-sync.ts        # pls sync (sync PR selection)
│   └── pr-release.ts     # pls release (post-merge tag + release)
│
├── domain/
│   ├── bump.ts           # calculateBump (pure)
│   ├── commits.ts        # parseCommits, Commit type
│   ├── files.ts          # buildReleaseFiles (pure)
│   ├── changelog.ts      # generateChangelog (pure)
│   ├── pr-body.ts        # generatePRBody, parseSelection
│   └── types.ts          # VersionBump, Release, etc.
│
├── clients/
│   ├── local-git.ts      # LocalGit implementation
│   ├── github.ts         # GitHubClient implementation
│   └── types.ts          # Client interfaces
│
└── lib/
    ├── error.ts          # PlsError
    └── semver.ts         # Version parsing utilities
```

---

## Refactoring Path

### Phase 1: Fix Branch Parameter
- Change `GitHubBackend.updateBranchRef` to take branch as parameter
- Eliminates factory pattern immediately

### Phase 2: Extract GitHubClient
- Move PR operations from `ReleasePullRequest` into `GitHubClient`
- Single client for all GitHub operations

### Phase 3: Pure Domain Services
- Extract `buildReleaseFiles` as pure function
- Extract `calculateBump`, `generateChangelog` as pure functions
- Move file-building logic out of backends

### Phase 4: Workflow Separation
- Create `PRCreateWorkflow`, `PRSyncWorkflow`, `PRReleaseWorkflow`, `LocalReleaseWorkflow`
- Thin orchestration layer
- Delete `ReleaseManager`, `ReleasePullRequest` classes

### Phase 5: Remove SHA from versions.json
- Update versions.json schema (version only)
- Add tag lookup for SHA
- Add fallback commit search

### Phase 6: Cleanup
- Delete `Storage` interface
- Delete `Manifest` classes
- Delete `versions/mod.ts`
- Consolidate into clean layer structure
