/** Repository contents and CI checkouts that differ from the happy path. */

import {
  cycle,
  expectLoudIfNot,
  expectReleased,
  feature,
  fix,
  need,
  releaseNotes,
  type Scenario,
  shipPending,
} from '../scenario/steps.ts';
import { NotApplicable, type World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

export const environment: Scenario[] = [
  {
    id: 'environment/long-history',
    group: 'Environment',
    title: '600 commits since the last release',
    why:
      'Busy or agent-driven repositories pile up commits. The oldest unreleased change must still be in the notes.',
    async run(w: World) {
      await w.land(feature('add import command'));
      // 600 further commits, created locally and pushed at once.
      await w.pull();
      await w.bulkCommits(600, 'chore: maintenance $i');
      await w.sh('git push -q origin main');
      await w.settle();
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      const notes = `${await releaseNotes(w, '1.1.0')}\n${await w.file('CHANGELOG.md') ?? ''}`;
      w.expect(
        notes.includes('add import command'),
        'the oldest unreleased change (a feature, 600 commits back) is missing from the notes',
      );
    },
  },
  {
    id: 'environment/shallow-checkout',
    group: 'Environment',
    title: 'CI uses the default shallow checkout everywhere',
    why:
      'actions/checkout fetches one commit by default. Forgetting fetch-depth must not look like "nothing to release".',
    options: { workflow: { fetchDepth: 1 } },
    async run(w: World) {
      await w.land(feature('add export command'));
      if (has(w.tool, 'release-pr')) {
        const pr = w.tool.releasePR(w);
        expectLoudIfNot(w, pr !== undefined, 'no release pull request was opened');
        if (!pr) return;
        await shipPending(w);
      }
      const ok = (await w.tag(w.tool.tagName('1.1.0'))) !== null;
      expectLoudIfNot(w, ok, '1.1.0 was not released');
      if (!ok) return;
      await expectReleased(w, '1.1.0');
      const notes = await releaseNotes(w, '1.1.0');
      expectLoudIfNot(
        w,
        notes.includes('add export command'),
        `release notes for 1.1.0 do not mention the change:\n${notes || '(empty)'}`,
      );
    },
  },
  {
    id: 'environment/unicode',
    group: 'Environment',
    title: 'Non-ASCII text survives three releases',
    why:
      'Changelogs contain names, quotes and symbols. Each release must leave earlier text byte-identical.',
    async run(w: World) {
      need(w, 'changelog-file');
      const line = '- café ⚠️ 日本語 — naïve “quotes”';
      const existing = await w.file('CHANGELOG.md') ?? '# Changelog\n';
      await w.land('docs: record history', 'push', {
        files: { 'CHANGELOG.md': `${existing.trimEnd()}\n${line}\n` },
      });
      await cycle(w, [feature('support naïve café ☕ input')]);
      await cycle(w, [fix('handle empty input')]);
      await cycle(w, [fix('trim whitespace')]);
      const after = await w.file('CHANGELOG.md') ?? '';
      w.expect(
        after.includes(line),
        `existing changelog line was altered. Lines now containing "caf":\n` +
          after.split('\n').filter((l) => l.includes('caf')).join('\n').slice(0, 600),
      );
      w.expect(
        after.includes('support naïve café ☕ input'),
        'the non-ASCII change summary is not intact in the changelog',
      );
    },
  },
  {
    id: 'environment/large-changelog',
    group: 'Environment',
    title: 'A changelog larger than 1 MB keeps its history',
    why: 'The contents API returns no content above 1 MB. Old history must not be dropped.',
    async run(w: World) {
      need(w, 'changelog-file');
      const existing = await w.file('CHANGELOG.md') ?? '# Changelog\n';
      const filler = Array.from(
        { length: 26000 },
        (_, i) => `- old entry ${i} lorem ipsum dolor sit amet consectetur`,
      ).join('\n');
      await w.land('docs: import old history', 'push', {
        files: {
          'CHANGELOG.md': `${existing.trimEnd()}\n\n## 0.9.0\n\n- OLD-HISTORY-MARKER\n${filler}\n`,
        },
      });
      const before = (await w.bytes('CHANGELOG.md'))?.length ?? 0;
      w.expect(before > 1024 * 1024, `test setup: changelog is only ${before} bytes`);
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const after = await w.file('CHANGELOG.md') ?? '';
      w.expect(
        after.includes('OLD-HISTORY-MARKER'),
        `changelog shrank from ${before} to ${after.length} bytes and lost its history`,
      );
      w.expect(after.includes('add export command'), 'changelog lacks the new entry');
    },
  },
  {
    id: 'environment/executable-version-file',
    group: 'Environment',
    title: 'A version kept in an executable script keeps its mode',
    why: 'Shell entry points carry versions. Losing the executable bit breaks them.',
    async run(w: World) {
      if (!w.tool.trackFile) {
        throw new NotApplicable(`${w.tool.name} adapter has no generic version file`);
      }
      await w.tool.trackFile(
        w,
        'bin/widget',
        '#!/bin/sh\n# @pls-version\nVERSION="1.0.0"\necho "$VERSION"\n',
        0o755,
      );
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const entry = await w.repo.git.entryAt('refs/heads/main', 'bin/widget');
      w.expect(
        entry?.mode === '100755',
        `bin/widget has mode ${entry?.mode} after the release, was 100755`,
      );
    },
  },
  {
    id: 'environment/manifest-formatting',
    group: 'Environment',
    title: 'Only the version line of package.json changes',
    why: 'Reformatting a manifest creates noisy diffs and fights with the project formatter.',
    async run(w: World) {
      // The manifest the tool adopted, restyled: four-space indent, inline array and
      // object. Its own fields stay (a `private` flag decides whether a tool publishes).
      const adopted = JSON.parse(await w.file('package.json') ?? '{}') as Record<string, unknown>;
      const fields = Object.entries(adopted).map(([k, v]) => `    "${k}": ${JSON.stringify(v)}`);
      const pkg = [
        '{',
        [...fields, '    "files": ["dist", "src"]', '    "scripts": { "test": "node test.js" }']
          .join(',\n'),
        '}',
        '',
      ].join('\n');
      await w.land('chore: reformat package.json', 'push', { files: { 'package.json': pkg } });
      await cycle(w, [feature('add export command')]);
      const after = await w.file('package.json') ?? '';
      const a = pkg.split('\n');
      const b = after.split('\n');
      const changed = b.filter((line, i) => line !== a[i]).length + Math.abs(a.length - b.length);
      w.expect(after.includes('1.1.0'), `package.json was not updated:\n${after}`);
      w.expect(changed === 1, `${changed} lines of package.json changed, expected 1:\n${after}`);
    },
  },
];
