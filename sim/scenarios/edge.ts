/** Edge cases: unusual history, versions, file contents and repository states. */

import {
  breaking,
  changelogSection,
  chore,
  cycle,
  expectLoudIfNot,
  expectReleased,
  feature,
  fix,
  need,
  releaseCommit,
  releaseNotes,
  type Scenario,
  shipPending,
} from '../scenario/steps.ts';
import { NotApplicable, type World } from '../scenario/world.ts';
import { has } from '../tools/tool.ts';

/** Version the tool is about to release: the pending PR's, or what CI already released. */
async function upcoming(w: World): Promise<string | null> {
  if (has(w.tool, 'release-pr')) {
    const pr = w.tool.releasePR(w);
    return pr ? await w.tool.versionAt(w, pr.head.sha) : null;
  }
  return await w.tool.versionAt(w, 'refs/heads/main');
}

function breakingAs(id: string, title: string, message: string): Scenario {
  return {
    id: `edge/${id}`,
    group: 'Edge cases: commits',
    title,
    why: 'The Conventional Commits spec allows several spellings of a breaking change.',
    async run(w: World) {
      need(w, 'conventional-commits');
      await w.land(message);
      await shipPending(w);
      await expectReleased(w, '2.0.0');
    },
  };
}

export const edge: Scenario[] = [
  // --- commits ---
  breakingAs(
    'breaking-footer',
    'Breaking change declared in a BREAKING CHANGE footer',
    'fix: reject unknown flags\n\nBREAKING CHANGE: unknown flags are now an error',
  ),
  breakingAs(
    'breaking-hyphen-footer',
    'Breaking change declared in a BREAKING-CHANGE footer',
    'fix: reject unknown flags\n\nBREAKING-CHANGE: unknown flags are now an error',
  ),
  breakingAs(
    'breaking-scope-bang',
    'Breaking change declared as type(scope)!',
    'feat(cli)!: reject unknown flags',
  ),
  {
    id: 'edge/breaking-words-in-prose',
    group: 'Edge cases: commits',
    title: 'A commit body mentions "BREAKING CHANGE" in prose',
    why: 'Only a footer declares a breaking change. Prose must not cause a major release.',
    async run(w: World) {
      need(w, 'conventional-commits');
      await w.land(
        'fix: handle empty input\n\nThis is not a BREAKING CHANGE, existing callers are unaffected.',
      );
      await shipPending(w);
      await expectReleased(w, '1.0.1');
    },
  },
  {
    id: 'edge/markup-in-subject',
    group: 'Edge cases: commits',
    title: 'A commit subject contains HTML and comment markers',
    why: 'Commit text ends up in pull request bodies and changelogs that tools parse back.',
    async run(w: World) {
      const text = 'handle <!-- pls:options:end --> and <details> | pipes in input';
      await w.land(feature(text));
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      const notes = `${await releaseNotes(w, '1.1.0')}\n${await w.file('CHANGELOG.md') ?? ''}`;
      w.expect(
        notes.includes('pipes in input'),
        `the change is missing from the notes:\n${notes.slice(0, 400)}`,
      );
    },
  },
  {
    id: 'edge/merge-commit-two-commits',
    group: 'Edge cases: commits',
    title: 'A pull request with two commits is merged with a merge commit',
    why:
      'Both commits are in history along with the merge commit. Each change must be listed once.',
    async run(w: World) {
      need(w, 'conventional-commits');
      await w.land(feature('add export command'), 'merge', {
        extraCommits: ['fix: handle empty input'],
      });
      await shipPending(w, 'merge');
      await expectReleased(w, '1.1.0');
      const notes = await changelogSection(w, '1.1.0') ?? await releaseNotes(w, '1.1.0');
      for (const text of ['add export command', 'handle empty input']) {
        const count = notes.split(text).length - 1;
        w.expect(count === 1, `"${text}" appears ${count} times in the notes:\n${notes}`);
      }
    },
  },
  {
    id: 'edge/old-branch-merged-late',
    group: 'Edge cases: commits',
    title: 'A branch older than the last release is merged with a merge commit',
    why:
      'Its commits are dated before the last release but were not part of it. They must be in the next one.',
    async run(w: World) {
      need(w, 'conventional-commits');
      // Work starts on a branch, then a release happens on main, then the branch is merged.
      await w.pull();
      const old = w.model.tick();
      await w.write({ 'src/slow.txt': 'slow work\n' });
      await w.sh(
        'git checkout -q -b slow-work && git add -A && git commit -q -m "fix: handle empty input" && ' +
          'git push -q origin slow-work && git checkout -q main',
        { env: { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } },
      );
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const pr = await w.model.createPR(w.repo, {
        title: 'Handle empty input',
        head: 'slow-work',
        base: 'main',
      }, { actor: w.contributor, token: w.contributorPat });
      await w.merge(pr, 'merge');
      await w.settle();
      await shipPending(w, 'merge');
      await expectReleased(w, '1.1.1');
      const notes = await releaseNotes(w, '1.1.1');
      w.expect(notes.includes('handle empty input'), `notes for 1.1.1 lack the fix:\n${notes}`);
    },
  },
  {
    id: 'edge/revert-before-release',
    group: 'Observations',
    title: 'A feature is reverted before it is released',
    why: 'Tools differ on whether a reverted feature still produces a minor release.',
    async run(w: World) {
      const sha = await w.land(feature('add export command'));
      await w.land(`revert: feat: add export command\n\nThis reverts commit ${sha}.`);
      w.note(`after a feature and its revert: ${await upcoming(w) ?? 'nothing pending'}`);
    },
  },
  {
    id: 'edge/squash-hides-feature',
    group: 'Observations',
    title: 'A pull request titled "chore" containing a feat commit is squash-merged',
    why: 'With squash merges the pull request title decides the commit type.',
    async run(w: World) {
      await w.land('chore: tidy up', 'squash', { extraCommits: ['feat: add export command'] });
      w.note(
        `after squash-merging a chore PR that contains a feat commit: ${
          await upcoming(w) ?? 'nothing pending'
        }`,
      );
    },
  },

  // --- versions ---
  {
    id: 'edge/minor-rollover',
    group: 'Edge cases: versions',
    title: '1.9.0 to 1.10.0, then 1.10.1',
    why: 'Versions compared as text put 1.10.0 before 1.9.0 and pick the wrong "latest".',
    options: { initialVersion: '1.9.0' },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.10.0');
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.10.1');
      const notes = await releaseNotes(w, '1.10.1');
      w.expect(
        !notes.includes('add export command'),
        `notes for 1.10.1 include a change from 1.10.0, so the previous release was misidentified:\n${notes}`,
      );
    },
  },
  {
    id: 'edge/pre-1.0-breaking',
    group: 'Observations',
    title: 'A breaking change on 0.3.0',
    why: 'Semver leaves 0.x open; tools choose between 0.4.0 and 1.0.0.',
    options: { initialVersion: '0.3.0' },
    async run(w: World) {
      await w.land(breaking('remove legacy flag'));
      w.note(`breaking change on 0.3.0: ${await upcoming(w) ?? 'nothing pending'}`);
    },
  },

  // --- files ---
  {
    id: 'edge/crlf',
    group: 'Edge cases: files',
    title: 'Files with CRLF line endings keep them',
    why: 'Windows-authored repositories. Mixed line endings make every later diff noisy.',
    async run(w: World) {
      const pkg = (await w.file('package.json') ?? '').replace(/\r?\n/g, '\r\n');
      await w.land('chore: use crlf', 'push', { files: { 'package.json': pkg } });
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const after = await w.file('package.json') ?? '';
      const lf = after.split('\n').length - 1;
      const crlf = after.split('\r\n').length - 1;
      w.expect(
        lf === crlf,
        `package.json has ${crlf} CRLF and ${lf - crlf} bare LF line endings after the release`,
      );
    },
  },
  {
    id: 'edge/changelog-preamble',
    group: 'Edge cases: files',
    title: 'A changelog with an introduction keeps it on top',
    why: 'Keep a Changelog style files start with prose. New entries belong below it.',
    async run(w: World) {
      need(w, 'changelog-file');
      const existing = await w.file('CHANGELOG.md') ?? '';
      const heading = existing.split('\n')[0];
      const rest = existing.split('\n').slice(1).join('\n');
      const intro = 'All notable changes to this project are documented here. INTRO-MARKER';
      await w.land('docs: add changelog introduction', 'push', {
        files: { 'CHANGELOG.md': `${heading}\n\n${intro}\n${rest}` },
      });
      await cycle(w, [feature('add export command')]);
      const after = await w.file('CHANGELOG.md') ?? '';
      w.expect(after.includes('INTRO-MARKER'), 'the introduction was removed from CHANGELOG.md');
      w.expect(
        after.indexOf('INTRO-MARKER') < after.indexOf('add export command'),
        'the new entry was placed above the introduction',
      );
    },
  },
  {
    id: 'edge/no-changelog',
    group: 'Edge cases: files',
    title: 'The repository has no CHANGELOG.md yet',
    why: 'First use on an existing project. The file should be created, not required.',
    async run(w: World) {
      need(w, 'changelog-file');
      await w.land('chore: remove changelog', 'push', { files: { 'CHANGELOG.md': null } });
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const after = await w.file('CHANGELOG.md');
      w.expect(
        after?.includes('add export command'),
        'CHANGELOG.md was not created with the new entry',
      );
    },
  },
  {
    id: 'edge/version-file-unmarked',
    group: 'Edge cases: files',
    title: 'A configured version file has no place for the tool to write',
    why: 'A misconfigured version file must fail the release, not ship a stale version constant.',
    async run(w: World) {
      if (!w.tool.trackFile) {
        throw new NotApplicable(`${w.tool.name} adapter has no generic version file`);
      }
      await w.tool.trackFile(w, 'src/build-info.txt', 'VERSION=1.0.0\n', 0o644);
      await w.land(feature('add export command'));
      if (has(w.tool, 'release-pr')) {
        const pr = w.tool.releasePR(w);
        const updated = pr
          ? (await w.file('src/build-info.txt', pr.head.sha))?.includes('1.1.0')
          : false;
        expectLoudIfNot(
          w,
          updated === true,
          'the version file was left at 1.0.0 in the pending release',
        );
      }
    },
  },
  {
    id: 'edge/huge-notes',
    group: 'Edge cases: files',
    title: '400 features with long descriptions in one release',
    why: 'Pull request bodies are limited to 65,536 characters. The release must still go through.',
    async run(w: World) {
      await w.pull();
      const long = 'x'.repeat(150);
      const first = await w.tool.change(w, feature('add export command FIRST-MARKER'));
      await w.commit(first.message, { 'src/first.txt': 'first\n', ...first.files });
      await w.bulkCommits(400, `feat: add generated capability number $i ${long}`);
      await w.sh('git push -q origin main');
      await w.settle();
      if (has(w.tool, 'release-pr')) {
        expectLoudIfNot(w, w.tool.releasePR(w) !== undefined, 'no release pull request was opened');
        if (!w.tool.releasePR(w)) return;
        await shipPending(w);
      }
      await expectReleased(w, '1.1.0');
    },
  },

  // --- repository state ---
  {
    id: 'edge/release-pr-closed',
    group: 'Edge cases: repository state',
    title: 'The release pull request is closed without merging',
    why: 'Declining a release must not stop future ones. The next change needs a release PR again.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      w.model.updatePR(w.repo, w.releasePR().number, { state: 'closed' }, w.web);
      await w.settle();
      await w.land(fix('handle empty input'));
      const pr = w.tool.releasePR(w);
      expectLoudIfNot(w, pr !== undefined, 'no release pull request is open after the next change');
      if (!pr) return;
      await shipPending(w);
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'edge/release-branch-deleted',
    group: 'Edge cases: repository state',
    title: 'Someone deletes the release branch',
    why: 'Branch clean-up scripts do this. The tool must recreate the branch and the PR.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      const branch = w.releasePR().head.ref;
      await w.sh(`git push -q origin :refs/heads/${branch}`);
      await w.settle();
      await w.land(fix('handle empty input'));
      expectLoudIfNot(
        w,
        w.tool.releasePR(w) !== undefined,
        'no release pull request after the branch was deleted',
      );
      if (!w.tool.releasePR(w)) return;
      await shipPending(w);
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'edge/tag-deleted',
    group: 'Edge cases: repository state',
    title: 'The tag of the latest release is deleted',
    why:
      'Recovery must put the tag back on the release commit, not on a later one, and not release twice.',
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      const tag = w.tool.tagName('1.1.0');
      await w.pull();
      await w.sh(`git push -q origin :refs/tags/${tag}`);
      await w.land(chore('update ci config'));
      const now = await w.tag(tag);
      const expected = await releaseCommit(w, '1.1.0');
      expectLoudIfNot(
        w,
        now !== null && now.commit === expected,
        now
          ? `tag ${tag} is back on ${now.commit.slice(0, 7)}, the release commit is ${
            expected?.slice(0, 7)
          }`
          : `tag ${tag} was not restored (files on main say ${await w.tool.versionAt(
            w,
            'refs/heads/main',
          )})`,
      );
      const count = w.repo.releases.filter((r) => r.tag_name === tag).length;
      w.expect(count <= 1, `${count} GitHub Releases exist for ${tag}`);
    },
  },
  {
    id: 'edge/release-object-deleted',
    group: 'Observations',
    title: 'The GitHub Release is deleted, the tag stays',
    why: 'Tools differ on whether they recreate a missing release for an existing tag.',
    async run(w: World) {
      need(w, 'github-release');
      await cycle(w, [feature('add export command')]);
      const release = w.release(w.tool.tagName('1.1.0'));
      if (release) w.model.deleteRelease(w.repo, release.id, w.web);
      await w.land(chore('update ci config'));
      w.note(
        w.release(w.tool.tagName('1.1.0'))
          ? 'the deleted GitHub Release was recreated on the next push'
          : 'the deleted GitHub Release was not recreated',
      );
    },
  },
  {
    id: 'edge/branch-named-like-tag',
    group: 'Edge cases: repository state',
    title: 'A branch has the same name as the next tag',
    why: 'A ref name that exists as both branch and tag is ambiguous to git and to the API.',
    async run(w: World) {
      await w.pull();
      const name = w.tool.tagName('1.1.0');
      await w.sh(`git push -q origin main:refs/heads/${name}`);
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'edge/changelog-edited-on-main',
    group: 'Edge cases: repository state',
    title: 'CHANGELOG.md changes on main while a release is pending',
    why:
      'The pending release then conflicts with main. It must be rebuilt and keep the manual edit.',
    async run(w: World) {
      need(w, 'release-pr');
      need(w, 'changelog-file');
      await w.land(feature('add export command'));
      const existing = await w.file('CHANGELOG.md') ?? '';
      await w.land('docs: annotate changelog', 'push', {
        files: {
          'CHANGELOG.md':
            `${existing.trimEnd()}\n\nMANUAL-NOTE: history before 1.0.0 lives in the wiki.\n`,
        },
      });
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      const after = await w.file('CHANGELOG.md') ?? '';
      w.expect(after.includes('MANUAL-NOTE'), 'the manual changelog edit on main was lost');
      w.expect(after.includes('add export command'), 'the release entry is missing');
    },
  },
  {
    id: 'edge/merge-before-ci-catches-up',
    group: 'Edge cases: repository state',
    title: 'The release is merged while a newer change has not been processed yet',
    why: 'The newer change is on main but not in the merged release notes. It must not be lost.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      await w.land(fix('handle empty input'), 'push', { settle: false });
      await w.merge(w.releasePR());
      await w.settle();
      await expectReleased(w, '1.1.0');
      const inRelease = (await releaseNotes(w, '1.1.0')).includes('handle empty input');
      const pr = w.tool.releasePR(w);
      const pendingText = pr
        ? `${pr.body}\n${await w.file('CHANGELOG.md', pr.head.sha) ?? ''}`
        : '';
      w.expect(
        inRelease || pendingText.includes('handle empty input'),
        'the fix is neither in the 1.1.0 notes nor in a pending release',
      );
    },
  },
  {
    id: 'edge/next-change-right-after-merge',
    group: 'Edge cases: repository state',
    title: 'A new feature lands before CI has processed the release merge',
    why:
      'CI then sees a head commit that is not the release commit. The release must still be tagged on the right commit.',
    async run(w: World) {
      need(w, 'release-pr');
      await w.land(feature('add export command'));
      await w.merge(w.releasePR());
      await w.land(feature('add import command'), 'push', { settle: false });
      await w.settle();
      await expectReleased(w, '1.1.0');
      const next = await upcoming(w);
      w.expect(next === '1.2.0', `the pending release is ${next ?? 'missing'}, expected 1.2.0`);
    },
  },
  {
    id: 'edge/rerun-old-run',
    group: 'Edge cases: repository state',
    title: 'An old workflow run is re-run after the release',
    why: 'Re-running a job for an old commit must not reopen, duplicate or move anything.',
    async run(w: World) {
      await w.land(feature('add export command'));
      const old = w.runner.runs.map((r) => r.id);
      await shipPending(w);
      await expectReleased(w, '1.1.0');
      const tagsBefore = (await w.tags()).sort().join(',');
      for (const id of old) w.runner.rerun(id);
      await w.settle();
      w.expect(
        (await w.tags()).sort().join(',') === tagsBefore,
        `tags changed: ${(await w.tags()).join(', ')}`,
      );
      w.expect(
        await w.tool.versionAt(w, 'refs/heads/main') === '1.1.0',
        `files on main now say ${await w.tool.versionAt(w, 'refs/heads/main')}`,
      );
      if (has(w.tool, 'release-pr')) {
        const pr = w.tool.releasePR(w);
        w.expect(
          !pr,
          `re-running old jobs opened a release pull request proposing ${
            pr ? await w.tool.versionAt(w, pr.head.sha) : ''
          }`,
        );
      }
      await expectReleased(w, '1.1.0');
    },
  },
  {
    id: 'edge/first-release-untagged',
    group: 'Edge cases: repository state',
    title: 'The project is at 1.0.0 but that version was never tagged',
    why:
      'Adopting a tool on an existing project. The first release must follow the files, not restart or replay history.',
    async run(w: World) {
      await w.pull();
      await w.sh(`git push -q origin :refs/tags/${w.tool.tagName('1.0.0')}`);
      w.repo.releases.length = 0;
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
    },
  },

  // --- settings ---
  {
    id: 'edge/squash-uses-pr-body',
    group: 'Edge cases: settings',
    title: 'Squash merges take the commit message from the pull request title and body',
    why:
      "A repository setting. The release commit message is then the PR text, not the tool's commit.",
    options: {
      settings: { squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'PR_BODY' },
    },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.1.1');
    },
  },
  {
    id: 'edge/delete-branch-on-merge',
    group: 'Edge cases: settings',
    title: 'Head branches are deleted automatically after merge',
    why: 'A common setting. The release branch disappears after every release.',
    options: { settings: { delete_branch_on_merge: true } },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      await cycle(w, [fix('handle empty input')]);
      await expectReleased(w, '1.1.1');
    },
  },
  {
    id: 'edge/pat-no-loop',
    group: 'Edge cases: settings',
    title: 'Workflows use a personal access token',
    why:
      "Events caused by a PAT do start workflows. The tool's own writes must not retrigger it forever.",
    options: { workflow: { token: 'PAT' } },
    async run(w: World) {
      await cycle(w, [feature('add export command')]);
      await expectReleased(w, '1.1.0');
      w.expect(w.runner.pending.length === 0, `${w.runner.pending.length} runs are still queued`);
      w.note(`${w.runner.runs.length} workflow runs for one release cycle with a PAT`);
      w.expect(
        w.runner.runs.length <= 12,
        `${w.runner.runs.length} workflow runs for one release cycle: the tool retriggers itself`,
      );
    },
  },
];
