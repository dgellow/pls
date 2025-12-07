# pls Architecture

## Mission

Automate semantic versioning releases. Read git history, calculate versions, update files, create releases.

## The Two Worlds

**Local execution**: Developer runs `pls` in terminal.
- Read: filesystem
- Write: filesystem → git commit → git tag
- History: git log

**Remote execution**: CI runs `pls prep`, webhook syncs PR.
- Read: GitHub Contents API
- Write: staged in memory → Git Data API (tree → commit → ref)
- History: local git (for prep) or irrelevant (for sync)

Fundamental tension: **local writes are incremental, remote writes are atomic**.

## Files That Change

Every release updates:
1. `deno.json` / `package.json` (version field)
2. `.pls/versions.json` (version + SHA per package)
3. `CHANGELOG.md` (prepend notes)
4. Optional: `version.ts` (exported constant)

For workspaces: multiple manifests, one versions.json.

## Core Operations

| Operation | Type | Description |
|-----------|------|-------------|
| Detect | Pure | What commits since last release? |
| Calculate | Pure | What's the new version? |
| Build | Pure | What files change, with what content? |
| Commit | I/O | Create commit with changes |
| Point | I/O | Update branch/tag to commit |
| Release | I/O | Create GitHub Release (optional) |
| PR | I/O | Create/update pull request (GitHub-only) |

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
│   LocalRelease    PRCreate    PRSync    Transition          │
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
│                            │  • updatePR / createRelease    │
│  (filesystem + git CLI)    │  (GitHub API)                  │
└────────────────────────────┴────────────────────────────────┘
```

## Key Design Principle

**Branch is a parameter, not configuration.**

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

## Client Interfaces

### LocalGit

```typescript
interface LocalGit {
  // Reading
  readFile(path: string): Promise<string | null>;
  fileExists(path: string): Promise<boolean>;

  // Git history
  getCommitsSince(sha: string | null): Promise<Commit[]>;
  getLastReleaseSha(): Promise<string | null>;

  // Writing
  commit(files: Map<string, string>, message: string): Promise<string>;
  pointBranch(name: string, sha: string): Promise<void>;
  createTag(name: string, sha: string): Promise<void>;
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
  getPR(number: number): Promise<PR>;
  createPR(options: PROptions): Promise<PR>;
  updatePR(number: number, options: PROptions): Promise<void>;

  // Releases
  createRelease(tag: string, notes: string): Promise<Release>;
  getLatestRelease(): Promise<Release | null>;
}
```

## Workflows

### LocalRelease

Command: `pls`

```typescript
class LocalReleaseWorkflow {
  constructor(private git: LocalGit) {}

  async run(dryRun: boolean): Promise<Release> {
    // Read
    const lastSha = await this.git.getLastReleaseSha();
    const commits = await this.git.getCommitsSince(lastSha);
    const manifest = await this.git.readFile('deno.json');

    // Compute (pure)
    const current = parseVersion(manifest);
    const bump = calculateBump(commits, current);
    const files = buildReleaseFiles(manifest, bump);

    if (dryRun) return preview(bump);

    // Write
    const sha = await this.git.commit(files, formatMessage(bump));
    await this.git.createTag(`v${bump.to}`, sha);

    return { version: bump.to, sha };
  }
}
```

### PRCreate

Command: `pls prep`

```typescript
class PRCreateWorkflow {
  constructor(
    private localGit: LocalGit,    // For commit history
    private github: GitHubClient,  // For GitHub operations
  ) {}

  async run(dryRun: boolean): Promise<PR> {
    // Read (local git for history, GitHub for current state)
    const lastSha = await this.localGit.getLastReleaseSha();
    const commits = await this.localGit.getCommitsSince(lastSha);
    const manifest = await this.github.readFile('deno.json');

    // Compute (pure)
    const bump = calculateBump(commits, parseVersion(manifest));
    const files = buildReleaseFiles(manifest, bump);
    const body = generatePRBody(bump);

    if (dryRun) return preview(bump);

    // Write
    const sha = await this.github.commit(files, formatMessage(bump));
    await this.github.pointBranch('pls-release', sha);

    const existing = await this.github.findPR('pls-release');
    if (existing) {
      await this.github.updatePR(existing.number, { title: `chore: release v${bump.to}`, body });
      return existing;
    }
    return await this.github.createPR({ branch: 'pls-release', title: `chore: release v${bump.to}`, body });
  }
}
```

### PRSync

Command: `pls prep --github-pr=N` (webhook trigger)

```typescript
class PRSyncWorkflow {
  constructor(private github: GitHubClient) {}

  async run(prNumber: number, dryRun: boolean): Promise<void> {
    // Read PR state
    const pr = await this.github.getPR(prNumber);
    const selection = parseVersionSelection(pr.body);
    const currentVersion = extractVersionFromTitle(pr.title);

    // No-op if already synced
    if (currentVersion === selection.version) return;

    // Compute
    const manifest = await this.github.readFile('deno.json');
    const files = buildReleaseFiles(manifest, selection);

    if (dryRun) return;

    // Write
    const sha = await this.github.commit(files, formatMessage(selection));
    await this.github.pointBranch(pr.head.ref, sha);
    await this.github.updatePR(prNumber, {
      title: `chore: release v${selection.version}`,
      body: updateSelection(pr.body, selection.version),
    });
  }
}
```

## What Dies

| Current Abstraction | Fate |
|---------------------|------|
| `Storage` interface | Absorbed. Reading = `getLatestRelease`. Writing = `createRelease`. |
| `Manifest` classes | Absorbed into `buildReleaseFiles`. Just JSON parsing. |
| `versions/mod.ts` | Absorbed. Just file reading + JSON. |
| `FileBackend` / `CommitBackend` | Replaced by `LocalGit` / `GitHubClient`. |
| Backend factories | Gone. Branch is a parameter. |
| `ReleasePullRequest` | Split into workflows + `GitHubClient`. |

## Refactoring Path

### Phase 1: Immediate Fix
- Fix `GitHubBackend.updateBranchRef` to take branch as parameter
- Eliminates factory pattern

### Phase 2: Extract GitHubClient
- Move PR operations from `ReleasePullRequest` into `GitHubClient`
- `ReleasePullRequest` uses `GitHubClient` instead of raw API calls

### Phase 3: Pure Domain Services
- Create `buildReleaseFiles` as pure function
- Move file-building logic out of backends
- Create `calculateBump`, `generateChangelog` as pure functions

### Phase 4: Workflow Separation
- Create `PRCreateWorkflow`, `PRSyncWorkflow`, `LocalReleaseWorkflow`
- Thin orchestration layer
- Delete `ReleaseManager`, `ReleasePullRequest` classes

### Phase 5: Cleanup
- Delete `Storage` interface (absorbed into clients)
- Delete `Manifest` classes (absorbed into domain services)
- Delete `versions/mod.ts` (absorbed into domain services)
- Consolidate into clean layer structure

## Directory Structure (Target)

```
src/
├── cli/
│   ├── main.ts           # Entry point, arg parsing
│   ├── prep.ts           # pls prep command
│   ├── transition.ts     # pls transition command
│   └── output.ts         # Formatting, colors, dry-run display
│
├── workflows/
│   ├── local-release.ts  # pls (local release)
│   ├── pr-create.ts      # pls prep (create/update PR)
│   ├── pr-sync.ts        # pls prep --github-pr=N
│   └── transition.ts     # pls transition
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
