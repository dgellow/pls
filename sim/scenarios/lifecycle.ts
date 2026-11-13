/** The normal release lifecycle under each GitHub merge method. */

import type { MergeMethod } from '../github/model.ts';
import {
  breaking,
  changelogSection,
  cycle,
  expectAllGreen,
  expectReleased,
  feature,
  fix,
  need,
  releaseNotes,
  type Scenario,
  shipPending,
} from '../scenario/steps.ts';
import type { World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

function basic(method: MergeMethod): Scenario {
  return {
    id: `lifecycle/${method}`,
    group: 'Lifecycle',
    title: `Feature released through a ${method} merge`,
    why: 'The basic promise: land a change, merge the release, get the right tag and release.',
    async run(w: World) {
      await cycle(w, [feature('add export command')], method);
      await expectReleased(w, '1.1.0');
      expectAllGreen(w);
    },
  };
}

export const lifecycle: Scenario[] = [
  basic('squash'),
  basic('merge'),
  basic('rebase'),
  {
    id: 'lifecycle/second-release',
    group: 'Lifecycle',
    title: 'Second release follows the first without a double bump',
    why:
      'After a release nothing should be pending, and the next change bumps from the new version.',
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      if (has(w.tool, 'release-pr')) {
        w.expect(
          !w.tool.releasePR(w),
          'a release pull request is open although nothing changed since the release',
        );
      }
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.1.1');
      expectAllGreen(w);
    },
  },
  {
    id: 'lifecycle/breaking',
    group: 'Lifecycle',
    title: 'Breaking change bumps the major version',
    why: 'Semver: a breaking change on 1.x must produce 2.0.0.',
    async run(w: World) {
      await cycle(w, [breaking('remove legacy flag')]);
      await expectReleased(w, '2.0.0');
    },
  },
  {
    id: 'lifecycle/accumulate',
    group: 'Lifecycle',
    title: 'Several changes accumulate into one pending release',
    why:
      'Each push must update the same pending release, not open another or lose earlier changes.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(fix('handle empty input'));
      await w.land(feature('add export command'));
      await w.land(fix('trim whitespace'));
      if (has(w.tool, 'release-pr')) {
        const open = w.openPRs();
        w.expect(open.length === 1, `expected one open pull request, found ${open.length}`);
      }
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      const notes = await releaseNotes(w, '1.1.0');
      for (const text of ['handle empty input', 'add export command', 'trim whitespace']) {
        w.expect(
          notes.includes(text),
          `release notes for 1.1.0 do not mention "${text}":\n${notes}`,
        );
      }
    },
  },
  {
    id: 'lifecycle/notes-scope',
    group: 'Lifecycle',
    title: 'Release notes contain this release only, and match the changelog',
    why: 'Notes that include older releases, or differ from the reviewed changelog, mislead users.',
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.1.1');
      const notes = await releaseNotes(w, '1.1.1');
      w.expect(notes.includes('handle empty input'), `notes for 1.1.1 lack the fix:\n${notes}`);
      w.expect(
        !notes.includes('add export command'),
        `notes for 1.1.1 include a change from 1.1.0:\n${notes}`,
      );
      if (has(w.tool, 'changelog-file') && has(w.tool, 'github-release')) {
        const section = await changelogSection(w, '1.1.1') ?? '';
        const items = (text: string) =>
          text.split('\n').filter((l) => /^\s*[-*] /.test(l)).map((l) =>
            l.replace(/^\s*[-*] /, '').replace(/\s*\(.*$/, '').replace(/^\w+(\(.*?\))?: /, '')
              .trim()
          ).sort();
        const a = items(section);
        const b = items(w.release(w.tool.tagName('1.1.1'))?.body ?? '');
        w.expect(
          JSON.stringify(a) === JSON.stringify(b),
          `changelog lists ${JSON.stringify(a)} but the GitHub Release lists ${JSON.stringify(b)}`,
        );
      }
    },
  },
];
