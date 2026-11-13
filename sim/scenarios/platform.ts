/** GitHub rules and settings that release tools run into. */

import {
  chore,
  cycle,
  expectAllGreen,
  expectLoudIfNot,
  expectReleased,
  feature,
  fix,
  need,
  releaseUnder,
  type Scenario,
  shipPending,
} from '../scenario/steps.ts';
import type { World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

/** Stand-in for `npm publish`: records the publication on the simulated host. */
const publish = 'curl -fsS -X POST -H "authorization: Bearer $GITHUB_TOKEN" ' +
  '"$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/dispatches" ' +
  `-d '{"event_type":"package-published"}'`;

function publications(w: World): number {
  return w.model.events.filter((e) =>
    e.name === 'repository_dispatch' && e.action === 'package-published'
  )
    .length;
}

export const platform: Scenario[] = [
  {
    id: 'platform/publish-without-pat',
    group: 'GitHub rules',
    title: 'Publish in the same workflow, with only GITHUB_TOKEN',
    why:
      "Releases created with GITHUB_TOKEN start no other workflow, so publishing must be driven by the tool's own result.",
    options: { workflow: { publish } },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const n = publications(w);
      w.expect(n === 1, `the package was published ${n} times, expected once\n${w.runSummary()}`);
    },
  },
  {
    id: 'platform/publish-retried',
    group: 'GitHub rules',
    title: 'Publishing fails once; the next push publishes',
    why: 'A registry outage after tagging must not leave a tagged version that is never published.',
    options: { workflow: { publish } },
    async run(w: World) {
      await releaseUnder(w, () =>
        w.sim.fault({
          name: 'registry down',
          kind: 'rest',
          method: 'POST',
          path: /\/dispatches$/,
          action: { type: 'status', status: 503 },
        }));
      w.expect(publications(w) === 0, 'test setup: the first publish attempt should have failed');
      await w.land(chore('update ci config'));
      const n = publications(w);
      w.expect(
        n === 1,
        `version 1.1.0 is tagged but was published ${n} times after the next push\n${w.runSummary()}`,
      );
    },
  },
  {
    id: 'platform/actions-cannot-open-prs',
    group: 'GitHub rules',
    title: 'The repository does not let GitHub Actions create pull requests',
    why: 'This is the default for many organisations. The run must fail and say what to change.',
    options: { settings: { actions_can_create_prs: false } },
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      expectLoudIfNot(w, w.tool.releasePR(w) !== undefined, 'no release pull request was opened');
      const failing = w.failedRuns().flatMap((r) => r.steps).find((s) =>
        s.exitCode && s.exitCode !== 0
      );
      const text = `${failing?.stdout ?? ''}${failing?.stderr ?? ''}`;
      if (
        failing &&
        !/not permitted to create|pull requests?.*setting|Allow GitHub Actions/i.test(text)
      ) {
        w.note('the failure output does not name the setting to change');
      }
    },
  },
  {
    id: 'platform/tag-ruleset',
    group: 'GitHub rules',
    title: 'A ruleset restricts who can create version tags',
    why: 'With protected tags the workflow token cannot tag. The run must fail, not skip quietly.',
    options: {
      settings: { restrict_tag_creation: { pattern: /^v/, bypass: ['pat', 'app', 'web'] } },
    },
    async run(w: World) {
      await w.land(feature('add export command'));
      if (has(w.tool, 'release-pr')) {
        const pr = w.tool.releasePR(w);
        expectLoudIfNot(w, pr !== undefined, 'no release pull request was opened');
        if (!pr) return;
        await shipPending(w);
      }
      const tagged = (await w.tag(w.tool.tagName('1.1.0'))) !== null;
      expectLoudIfNot(w, tagged, 'tag for 1.1.0 was not created');
    },
  },
  {
    id: 'platform/immutable-releases',
    group: 'GitHub rules',
    title: 'Immutable releases are enabled',
    why: 'Published releases lock their tag. Two consecutive releases must both work.',
    options: { settings: { immutable_releases: true } },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.1.1');
      expectAllGreen(w);
    },
  },
  {
    id: 'platform/protected-main',
    group: 'GitHub rules',
    title: 'main only accepts changes through pull requests',
    why: 'Tools that push release commits straight to main cannot work under this common rule.',
    options: { settings: { protected_branches: [{ pattern: /^main$/, bypass: ['merge'] }] } },
    async run(w: World) {
      await w.land(feature('add export command'), 'squash');
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      expectAllGreen(w);
    },
  },
];
