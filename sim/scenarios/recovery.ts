/** Things going wrong between the tool and GitHub, and whether the tool recovers. */

import type { Fault } from '../github/server.ts';
import {
  changelogHeadings,
  changelogSection,
  chore,
  expectLoudIfNot,
  expectReleased,
  feature,
  fix,
  need,
  releaseUnder,
  type Scenario,
} from '../scenario/steps.ts';
import type { World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

/** The first write a tool makes when it creates a tag or a release, by API or by git push. */
const releaseWrite: Fault['match'] = (c) =>
  (c.kind === 'rest' && c.method === 'POST' && /\/(git\/tags|git\/refs|releases)$/.test(c.path)) ||
  (c.kind === 'git' && c.method === 'POST' && c.path.endsWith('git-receive-pack'));

async function released(w: World, version: string): Promise<boolean> {
  return (await w.tag(w.tool.tagName(version))) !== null &&
    (!has(w.tool, 'github-release') || w.release(w.tool.tagName(version)) !== undefined);
}

export const recovery: Scenario[] = [
  {
    id: 'recovery/tag-write-fails-once',
    group: 'Failure and recovery',
    title: 'Creating the tag fails once with a 502',
    why: 'A transient GitHub error must not lose the release or tag the wrong commit later.',
    async run(w: World) {
      await releaseUnder(w, () =>
        w.sim.fault({
          name: '502 on release write',
          fromRun: true,
          match: releaseWrite,
          action: { type: 'status', status: 502 },
        }));
      expectLoudIfNot(w, await released(w, '1.1.0'), '1.1.0 was not released');
      // An unrelated push later: the release must be completed on the release commit.
      await w.land(chore('update ci config'));
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'recovery/release-write-denied',
    group: 'Failure and recovery',
    title: 'Creating the GitHub Release is denied (403)',
    why: 'A permission problem must fail the run, not report a release that does not exist.',
    async run(w: World) {
      need(w, 'github-release');
      await releaseUnder(w, () =>
        w.sim.fault({
          name: '403 on create release',
          kind: 'rest',
          method: 'POST',
          path: /\/releases$/,
          times: Infinity,
          action: {
            type: 'status',
            status: 403,
            body: { message: 'Resource not accessible by integration' },
          },
        }));
      expectLoudIfNot(
        w,
        w.release(w.tool.tagName('1.1.0')) !== undefined,
        'no GitHub Release exists for 1.1.0',
      );
      w.sim.clearFaults();
      await w.land(chore('update ci config'));
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'recovery/lost-response',
    group: 'Failure and recovery',
    title: 'The tag is created but the response is lost',
    why:
      'The classic partial failure: the write happened, the client saw an error. A retry must converge.',
    async run(w: World) {
      await releaseUnder(w, () =>
        w.sim.fault({
          name: 'lost response on release write',
          fromRun: true,
          match: releaseWrite,
          action: { type: 'lost-response' },
        }));
      await w.land(chore('update ci config'));
      await expectReleased(w, '1.1.0');
      const count = w.repo.releases.filter((r) => r.tag_name === w.tool.tagName('1.1.0')).length;
      w.expect(count <= 1, `${count} GitHub Releases exist for 1.1.0`);
      if (has(w.tool, 'changelog-file')) {
        const headings = await changelogHeadings(w, '1.1.0');
        w.expect(headings <= 1, `CHANGELOG.md has ${headings} sections for 1.1.0`);
      }
    },
  },
  {
    id: 'recovery/overlapping-runs',
    group: 'Failure and recovery',
    title: 'Two pushes in quick succession, older run finishes last',
    why:
      'Busy repositories merge faster than CI runs. The pending release must reflect the newest push.',
    async run(w: World) {
      need(w, 'release-pr');
      // First push: its runs start, read the repository, and are held at their first write.
      await w.land(feature('add export command'), 'push', { settle: false });
      const held = w.runner.takeAll().map(({ run, start }) => {
        const barrier = w.sim.barrier((req) =>
          req.runId === run.id && req.method !== 'GET' && !req.path.endsWith('git-upload-pack') &&
          !req.path.endsWith('/graphql')
        );
        const done = start();
        return { barrier, done, ready: Promise.race([barrier.reached, done.then(() => {})]) };
      });
      await Promise.all(held.map((h) => h.ready));
      // Second push arrives; its runs complete while the first ones are still held.
      await w.land(fix('handle empty input'), 'push', { settle: false });
      for (const { start } of w.runner.takeAll()) await start();
      // The older runs now finish last.
      for (const h of held) h.barrier.release();
      await Promise.all(held.map((h) => h.done));
      await w.settle();

      const pr = w.releasePR();
      const text = has(w.tool, 'changelog-file')
        ? await changelogSection(w, '1.1.0', pr.head.sha) ?? ''
        : pr.body;
      for (const summary of ['add export command', 'handle empty input']) {
        w.expect(
          text.includes(summary),
          `pending release lost "${summary}" after overlapping runs:\n${text || '(empty)'}`,
        );
      }
    },
  },
  {
    id: 'recovery/rate-limited',
    group: 'Failure and recovery',
    title: 'The API rate limit runs out during the release',
    why:
      'Hitting the limit must fail visibly and leave nothing half done that a rerun cannot finish.',
    async run(w: World) {
      w.runner.defaultStepTimeoutMs = 45_000;
      await releaseUnder(w, () => (w.sim.rateBudgetPerRun = 2));
      w.runner.defaultStepTimeoutMs = 120_000;
      expectLoudIfNot(w, await released(w, '1.1.0'), '1.1.0 was not released');
      w.sim.rateBudgetPerRun = null;
      await w.land(chore('update ci config'));
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'recovery/api-hangs',
    group: 'Failure and recovery',
    title: 'GitHub accepts a request and never answers',
    why: 'Without a client timeout the job hangs until the CI job limit (six hours by default).',
    async run(w: World) {
      w.runner.defaultStepTimeoutMs = 20_000;
      await releaseUnder(w, () =>
        w.sim.fault({
          name: 'hang',
          fromRun: true,
          match: (c) => c.kind !== 'git',
          times: Infinity,
          action: { type: 'hang' },
        }));
      const hung = w.runner.runs.filter((r) => r.conclusion === 'timed_out');
      w.expect(
        hung.length === 0,
        `${hung.length} run(s) were still waiting after 20 s and had to be killed: the tool sets no request timeout`,
      );
    },
  },
  {
    id: 'recovery/read-fails-once',
    group: 'Failure and recovery',
    title: 'A read fails once with a 502 while the pending release is updated',
    why: 'Either retry, or fail the run. Never treat a failed read as "file does not exist".',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      const before = w.releasePR().number;
      w.sim.fault({
        name: '502 on read',
        match: (c) => c.kind !== 'git' && (c.method === 'GET' || c.path.endsWith('/graphql')),
        skip: 1,
        action: { type: 'status', status: 502 },
      });
      await w.land(fix('handle empty input'));
      const open = w.openPRs();
      w.expect(open.length === 1, `expected one open pull request, found ${open.length}`);
      w.expect(open[0].number === before, 'the release pull request was replaced by a new one');
      const pending = await w.tool.versionAt(w, open[0].head.sha);
      w.expect(pending === '1.1.0', `pending release became ${pending} after a failed read`);
    },
  },
];
