/** A maintainer steering the pending release. */

import {
  changelogSection,
  expectReleased,
  feature,
  fix,
  need,
  type Scenario,
  shipPending,
} from '../scenario/steps.ts';
import { NotApplicable, type World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

function selector(w: World): (version: string) => Promise<void> {
  need(w, 'release-pr');
  const select = w.tool.selectVersion;
  if (!select) {
    throw new NotApplicable(`${w.tool.name} has no way to pick a version for a pending release`);
  }
  return (version) => select(w, version);
}

export const control: Scenario[] = [
  {
    id: 'control/edit-pr-title',
    group: 'Human control',
    title: 'Maintainer rewords the release pull request title before merging',
    why: 'Titles get edited. The release must still happen, for the version in the reviewed files.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      const pr = w.releasePR();
      w.model.updatePR(w.repo, pr.number, { title: 'Release: export command' }, w.web);
      await w.settle();
      const pending = await w.tool.versionAt(w, w.releasePR().head.sha);
      w.expect(pending === '1.1.0', `after the title edit the pending release is ${pending}`);
      if (has(w.tool, 'changelog-file')) {
        const section = await changelogSection(w, '1.1.0', w.releasePR().head.sha) ?? '';
        w.expect(
          section.includes('add export command'),
          `after the title edit the changelog entry lost the change:\n${section || '(no section)'}`,
        );
      }
      await shipPending(w);
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'control/edit-release-branch',
    group: 'Human control',
    title: 'Maintainer commits a changelog wording fix to the release branch',
    why:
      'People polish release notes in the PR. A later push must not silently discard that commit.',
    async run(w: World) {
      need(w, 'release-pr');
      need(w, 'changelog-file');
      await w.land(feature('add export command'));
      const branch = w.releasePR().head.ref;
      await w.sh(`git fetch -q origin ${branch} && git checkout -q -B edit FETCH_HEAD`);
      const changelog = await Deno.readTextFile(`${w.dev}/CHANGELOG.md`);
      await w.commit('docs: reword changelog', {
        'CHANGELOG.md': changelog.replace(
          'add export command',
          'add export command (see docs/export.md)',
        ),
      });
      await w.sh(`git push -q origin edit:${branch} && git checkout -q main`);
      await w.settle();
      await w.land(fix('handle empty input'));
      const pr = w.releasePR();
      const text = await w.file('CHANGELOG.md', pr.head.sha) ?? '';
      const kept = text.includes('see docs/export.md');
      if (!kept) {
        const told = pr.body.includes('reword') ||
          (w.repo.comments.get(pr.number) ?? []).length > 0 ||
          w.failedRuns().length > 0;
        w.expect(
          told,
          "the maintainer's commit on the release branch was discarded without any notice",
        );
        w.note('the manual commit was discarded, with a notice');
      }
    },
  },
  {
    id: 'control/pick-prerelease',
    group: 'Human control',
    title: 'Maintainer turns the pending release into a beta',
    why: 'Choosing a prerelease must change every version file and release exactly that version.',
    async run(w: World) {
      const select = selector(w);
      await w.land(feature('add export command'));
      await select('1.1.0-beta.0');
      await shipPending(w);
      await expectReleased(w, '1.1.0-beta.0');
    },
  },
  {
    id: 'control/pick-major',
    group: 'Human control',
    title: 'Maintainer forces a major release',
    why: 'Commit types are sometimes wrong; a maintainer needs to say "this one is 2.0.0".',
    async run(w: World) {
      const select = selector(w);
      await w.land(feature('add export command'));
      await select('2.0.0');
      await shipPending(w);
      await expectReleased(w, '2.0.0');
    },
  },
  {
    id: 'control/choice-survives-push',
    group: 'Human control',
    title: 'The chosen version survives a later push',
    why:
      'A choice that silently reverts when someone merges another change ships the wrong version.',
    async run(w: World) {
      const select = selector(w);
      await w.land(feature('add export command'));
      await select('1.1.0-beta.0');
      await w.land(fix('handle empty input'));
      const pending = await w.tool.versionAt(w, w.releasePR().head.sha);
      w.expect(
        pending === '1.1.0-beta.0',
        `after another push the pending release is ${pending}, not the chosen 1.1.0-beta.0`,
      );
      await shipPending(w);
      await expectReleased(w, '1.1.0-beta.0');
    },
  },
  {
    id: 'control/choice-keeps-changelog',
    group: 'Human control',
    title: 'Choosing a version keeps the changelog entry',
    why: 'The changelog is reviewed in the release PR; picking a version must not wipe it.',
    async run(w: World) {
      need(w, 'changelog-file');
      const select = selector(w);
      await w.land(feature('add export command'));
      await select('1.1.0-beta.0');
      const section = await changelogSection(w, '1.1.0-beta.0', w.releasePR().head.sha);
      w.expect(section, 'CHANGELOG.md on the release branch has no section for 1.1.0-beta.0');
      w.expect(
        section.includes('add export command'),
        `changelog section for 1.1.0-beta.0 lost the change:\n${section}`,
      );
    },
  },
  {
    id: 'control/prerelease-to-stable',
    group: 'Human control',
    title: 'Beta, another beta, then stable',
    why: 'A full prerelease cycle: each step must tag the right commit with the right version.',
    async run(w: World) {
      need(w, 'prerelease');
      const select = selector(w);
      await w.land(feature('add export command'));
      await select('1.1.0-beta.0');
      await shipPending(w);
      await expectReleased(w, '1.1.0-beta.0');

      await w.land(fix('handle empty input'));
      const next = await w.tool.versionAt(w, w.releasePR().head.sha);
      w.expect(
        next === '1.1.0-beta.1',
        `second beta is proposed as ${next}, expected 1.1.0-beta.1`,
      );
      await shipPending(w);
      await expectReleased(w, '1.1.0-beta.1');

      await w.land(fix('trim whitespace'));
      await select('1.1.0');
      await shipPending(w);
      await expectReleased(w, '1.1.0');
    },
  },
];
