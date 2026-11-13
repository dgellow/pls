/**
 * Observations: behaviour that differs between tools without a single right
 * answer, and cost figures. These scenarios record notes and always pass
 * unless the tool breaks.
 */

import { feature, type Scenario, shipPending } from '../scenario/steps.ts';
import type { World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

async function pendingVersion(w: World): Promise<string> {
  if (!has(w.tool, 'release-pr')) {
    const v = await w.tool.versionAt(w, 'refs/heads/main');
    return v === '1.0.0' ? 'none' : `released ${v}`;
  }
  const pr = w.tool.releasePR(w);
  return pr ? `pending ${await w.tool.versionAt(w, pr.head.sha)}` : 'none';
}

function costOf(w: World, from: number): string {
  const runs = w.runner.runs.slice(from);
  const calls = runs.flatMap((r) => w.runner.callsOf(r));
  const api = calls.filter((c) => c.kind !== 'git').length;
  const git = calls.filter((c) => c.kind === 'git').length;
  const ms = runs.reduce((sum, r) => sum + r.steps.reduce((s, step) => s + step.ms, 0), 0);
  return `${api} API calls, ${git} git requests, ${ms} ms in ${runs.length} run(s)`;
}

export const observe: Scenario[] = [
  {
    id: 'observe/docs-only',
    group: 'Observations',
    title: 'A documentation-only change lands',
    why: 'Tools differ on whether changes that do not affect users produce a release.',
    async run(w: World) {
      await w.land({ kind: 'docs', summary: 'explain the export format' });
      w.note(`after a docs change: ${await pendingVersion(w)}`);
    },
  },
  {
    id: 'observe/chore-only',
    group: 'Observations',
    title: 'A chore lands',
    why: 'Same question for maintenance commits.',
    async run(w: World) {
      await w.land({ kind: 'chore', summary: 'update ci config' });
      w.note(`after a chore: ${await pendingVersion(w)}`);
    },
  },
  {
    id: 'observe/unconventional-commit',
    group: 'Observations',
    title: 'A commit without a conventional prefix lands',
    why: 'Not every contributor or agent follows the convention.',
    async run(w: World) {
      await w.land('Update the readme with examples');
      w.note(`after an unconventional commit: ${await pendingVersion(w)}`);
    },
  },
  {
    id: 'observe/cost',
    group: 'Observations',
    title: 'Cost of each stage',
    why: 'API calls count against rate limits; time counts against CI minutes.',
    async run(w: World) {
      let mark = w.runner.runs.length;
      await w.land(feature('add export command'));
      w.note(`push with a releasable change: ${costOf(w, mark)}`);
      mark = w.runner.runs.length;
      await shipPending(w);
      w.note(`merge of the release: ${costOf(w, mark)}`);
      mark = w.runner.runs.length;
      // A push that changes nothing releasable for most tools: re-run CI on the same commit.
      await w.sh('git pull -q origin main 2>/dev/null || true');
      await w.pull();
      for (const workflow of w.runner.workflows) void workflow;
      w.model.emit(w.repo, 'push', undefined, {
        ref: 'refs/heads/main',
        before: await w.head(),
        after: await w.head(),
        commits: [],
        head_commit: null,
        repository: w.model.repoPayload(w.repo),
      }, w.web);
      await w.settle();
      w.note(`re-run with nothing to do: ${costOf(w, mark)}`);
    },
  },
];
