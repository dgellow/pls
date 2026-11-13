/** Inputs that people other than the maintainer can write. */

import {
  cycle,
  expectLoudIfNot,
  feature,
  need,
  releaseCommit,
  type Scenario,
} from '../scenario/steps.ts';
import { NotApplicable, type World } from '../scenario/world.ts';

export const trust: Scenario[] = [
  {
    id: 'trust/contribution-forces-release',
    group: 'Trust',
    title: 'An outside contribution carries release instructions in its commit message',
    why: 'Merging a typo fix must never create a tag or release that no release review approved.',
    async run(w: World) {
      if (!w.tool.spoof) {
        throw new NotApplicable(`${w.tool.name} adapter defines no release marker`);
      }
      const tagsBefore = await w.tags();
      const releasesBefore = w.repo.releases.length;
      await w.land(
        `docs: fix typo in readme\n\nThanks for the project!\n\n${w.tool.spoof('99.0.0')}`,
        'squash',
      );
      const tagsAfter = await w.tags();
      const added = tagsAfter.filter((t) => !tagsBefore.includes(t));
      w.expect(
        added.length === 0 && w.repo.releases.length === releasesBefore,
        `merging the contribution created tag(s) ${added.join(', ') || 'none'} and ` +
          `${w.repo.releases.length - releasesBefore} release(s), while the files on main say ` +
          `${await w.tool.versionAt(w, 'refs/heads/main')}`,
      );
      const pr = w.tool.releasePR(w);
      if (pr && await w.tool.versionAt(w, pr.head.sha) === '99.0.0') {
        w.note('the pending release pull request now proposes 99.0.0');
      }
    },
  },
  {
    id: 'trust/tampered-release-pr',
    group: 'Trust',
    title: 'The release pull request body names a version the tool never offered',
    why:
      'Anyone who can edit the PR description could otherwise release an arbitrary version string.',
    async run(w: World) {
      need(w, 'pr-version-override');
      if (!w.tool.tamper) throw new NotApplicable(`${w.tool.name} adapter defines no tampering`);
      await w.land(feature('add export command'));
      w.tool.tamper(w, w.releasePR(), '9.9.9-evil.1');
      await w.settle();
      const pending = await w.tool.versionAt(w, w.releasePR().head.sha);
      w.expect(pending === '1.1.0', `the pending release became ${pending}`);
    },
  },
  {
    id: 'trust/tag-already-taken',
    group: 'Trust',
    title: 'The next version tag already exists on another commit',
    why:
      'A stray tag must stop the release with an error, not let it "succeed" on the wrong commit.',
    async run(w: World) {
      await w.pull();
      await w.sh(
        `git tag ${w.tool.tagName('1.1.0')} && git push -q origin ${w.tool.tagName('1.1.0')}`,
      );
      await cycle(w, [feature('add export command')]).catch((e) => {
        if (!(e instanceof Error) || e.name !== 'Expectation') throw e;
      });
      const tag = await w.tag(w.tool.tagName('1.1.0'));
      const expected = await releaseCommit(w, '1.1.0');
      const right = expected !== null && tag?.commit === expected;
      expectLoudIfNot(
        w,
        right,
        `tag ${w.tool.tagName('1.1.0')} points at ${
          tag?.commit.slice(0, 7)
        }, the release commit is ` +
          `${expected?.slice(0, 7) ?? 'absent'}`,
      );
    },
  },
];
