# Release simulator

Runs release tools as real subprocesses against a simulated GitHub and a simulated GitHub Actions,
and checks what they leave behind. The same scenario runs against every tool.

```bash
deno run -A sim/run.ts                          # every tool, every scenario
deno run -A sim/run.ts --tool pls               # one tool
deno run -A sim/run.ts --scenario recovery/     # scenarios whose id contains the text
deno run -A sim/run.ts --list                   # list scenarios
deno run -A sim/report.ts                       # sim/out/results.json -> sim/out/report.md
deno test -A sim/                               # tests of the simulator itself
deno run -A sim/spec/conformance.ts             # check the simulated API against GitHub's OpenAPI description
```

Requirements: `git` (with `git http-backend`), `deno`, `node` and `npm` for the Node-based tools,
`jq` and `curl` for workflow steps. Tools are installed into `sim/.cache/` on first use.

## Report

The report (verdict matrix, observations, detail of every failure) is built by the `Simulation`
workflow (`.github/workflows/sim.yml`) on every push to `main` and on every pull request that
changes `src/` or `sim/`. Each tool runs in its own job, in parallel; a final job merges the four
results. The report is on the run's summary page and in the `simulation-report` artifact. The
`simulation-<tool>` artifacts hold each tool's `results.json` and per-scenario logs. The report is
not committed: the latest run on `main` is the current state.

Locally, `deno run -A sim/run.ts` followed by `deno run -A sim/report.ts` writes the same report to
`sim/out/report.md`. `report.ts` takes `--in` several times to merge separate runs.

## What is simulated

**GitHub** (`sim/github/`). One HTTP server. The REST API, the GraphQL API and git smart HTTP all
operate on the same real bare repositories, so SHAs, trees, tags and merge results come from git.

- REST: contents, git data (blobs, trees, commits, refs, tags), branches, commits, compare, pull
  requests, issues labels and comments, releases, search, dispatches. Status codes and error bodies
  follow api.github.com (`422 Reference already exists`, `already_exists` on duplicate releases,
  `A pull request already exists`, `Update is not a fast forward`, no content above 1 MB).
- GraphQL: the specific queries and mutations release-please and changesets/action send.
- Git: `git http-backend`, so clone, shallow and partial fetch, fetch by SHA, `ls-remote` and push
  are real. `refs/pull/N/head` and `refs/pull/N/merge` exist.
- Merging: merge commit, squash and rebase, with GitHub's default commit messages, authors and
  committers. A pull request whose head has no commits ahead of base is closed.
- Rules: token kinds (PAT, `GITHUB_TOKEN`, App) with permissions, "Allow GitHub Actions to create
  pull requests", tag rulesets, protected branches, immutable releases. Rules apply to API writes
  and to pushes (through a pre-receive hook).
- Events: push, create, delete, pull_request, release, dispatches, each recording what caused it.

**Network** (`sim/github/net.ts`). A TCP proxy in front of the server: connection closed without a
response, response lost after the write was applied, host down, host that never answers, latency.
HTTP-level faults (status codes, rate limits) are injected in the server.

**GitHub Actions** (`sim/actions/runner.ts`). Workflows run as subprocesses in a fresh workspace:

- Events caused by `GITHUB_TOKEN` start no workflows; pull requests it opens wait for approval.
- Each run has its own `GITHUB_TOKEN`, which stops working when the run ends.
- Checkout follows actions/checkout: depth 1 and no tags by default, the event commit even when the
  branch has moved, the merge ref for pull request events.
- No git identity is configured. `[skip ci]` is honoured.

**People** (`sim/scenario/world.ts`). A maintainer and a contributor push from their own clones with
real git, open pull requests, and use the web UI (merge, edit a description).

## What is not simulated

- Timing. Runs execute one after another unless a scenario interleaves them with barriers.
- GitHub's own latency, pagination limits beyond `per_page`, abuse detection, and webhooks to
  external services.
- Commit signatures: a set of SHAs GitHub would show as Verified is kept, but no signature exists.
- Package registries. Publishing is stood in for by a `repository_dispatch` call. Tool processes are
  told the npm registry is at the simulator (`npm_config_registry`), so a tool that asks the
  registry or tries to publish gets a 404 and the scenario is reported as `gap`; nothing is sent to
  registry.npmjs.org.
- A network sandbox. Apart from the npm registry setting, tool processes run with the machine's
  network. No tool under test contacted another host in the recorded runs (every scenario log was
  searched), but nothing prevents a tool from doing so.
- Anything a tool needs that is not implemented answers 404 and is reported as `gap`, not as tool
  behaviour.

## How the simulated API is checked against GitHub

1. **Schemas.** `sim/spec/gen_shapes.ts` reads GitHub's OpenAPI description
   (`github/rest-api-description`) and generates `sim/github/shapes.json`: for each of the 56
   operations the simulator implements, the response schema and a default for every required
   property. Handlers set the fields that carry meaning; the server fills the rest, so responses
   have the fields real ones have. `sim/spec/conformance.ts` then drives every operation, including
   error paths, and validates each response body against the description.
2. **Status codes.** The same run checks that every status code returned is one the description
   documents for that operation. The description does not list generic 401, 403 and 404 answers on
   every operation; those are reported separately.
3. **Behaviour.** Rules that a schema cannot express were checked against the description's prose
   (merge 405 and 409, `target_commitish` ignored when the tag exists, fast-forward rule for ref
   updates, squash title and message settings), against the actions/checkout source (depth 1, no
   tags, event commit re-fetched when the branch moved), and against real objects from this
   repository (an API-created annotated tag, its release, a merged release PR).

```bash
deno run -A sim/spec/gen_shapes.ts     # regenerate shapes.json from the OpenAPI description
deno run -A sim/spec/conformance.ts    # validate the simulator against it
```

Known limits of that check:

- It has not been run against live api.github.com. Error message texts are not in the description
  and come from documentation and the tools' own error handling.
- For files between 1 and 100 MB the description states the empty `content` with `encoding: "none"`
  for the `object` media type. The simulator returns the same for the default media type, which
  matches reports from client developers but is not stated by the description.
- GraphQL responses are checked only by the tools that consume them.
- Webhook payloads delivered to workflows carry the fields tools read, not the full schemas.

## Verdicts

| Verdict | Meaning                                                    |
| ------- | ---------------------------------------------------------- |
| pass    | Every expectation held                                     |
| FAIL    | An expectation did not hold                                |
| n/a     | The scenario does not apply to the tool                    |
| gap     | The tool needed something the simulator does not implement |
| error   | The harness failed                                         |

Many scenarios use "loud" expectations: an outcome may be incomplete as long as a workflow run
failed, so that someone finds out. Silent wrong outcomes fail.

A run ends when the last scenario has been written to `results.json`. If the process is still alive
ten seconds later, a scenario left a server, a timer or a subprocess open; the runner says so and
exits with status 3. `World.create` closes its server when a tool cannot be adopted, and
`sim/scenario/world_test.ts` checks that.

## Tools

| Tool             | How it is run                                                            |
| ---------------- | ------------------------------------------------------------------------ |
| pls              | Compiled from this working tree; workflows from `design.md`              |
| release-please   | `googleapis/release-please-action` v5.0.0, manifest mode                 |
| changesets       | `@changesets/cli` 3.0.3 with `changesets/action` v2.1.2, private package |
| semantic-release | 25.0.9 with the changelog, git and github plugins                        |

Each adapter (`sim/tools/*.ts`) states how a project adopts the tool, the workflows its
documentation prescribes, how a change is marked (commit message or change file), and how a
maintainer overrides the version.

To add a tool, implement `Tool` from `sim/tools/tool.ts` and add it to `sim/tools/mod.ts`. To add a
scenario, add a `Scenario` to a file in `sim/scenarios/` and list it in `mod.ts`.
