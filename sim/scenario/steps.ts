/**
 * Steps and checks shared by scenarios.
 */

import type { MergeMethod, PullRequest } from '../github/model.ts';
import { type Change, has } from '../tools/tool.ts';
import { Expectation, NotApplicable, type World } from './world.ts';

export interface Scenario {
  id: string;
  group: string;
  title: string;
  /** What a user would observe if this goes wrong. */
  why: string;
  /** World options for this scenario. */
  options?: import('./world.ts').WorldOptions;
  run(w: World): Promise<void>;
}

export const feature = (summary: string): Change => ({ kind: 'feature', summary });
export const fix = (summary: string): Change => ({ kind: 'fix', summary });
export const breaking = (summary: string): Change => ({ kind: 'breaking', summary });
export const chore = (summary: string): Change => ({ kind: 'chore', summary });

export function need(w: World, capability: import('../tools/tool.ts').Capability): void {
  if (!has(w.tool, capability)) throw new NotApplicable(`${w.tool.name} has no ${capability}`);
}

/**
 * Merge the pending release, the way a maintainer would: merge the release PR
 * if the tool uses one. Tools that release straight from CI have already
 * released by the time this is called.
 */
export async function shipPending(
  w: World,
  method: MergeMethod = 'squash',
): Promise<PullRequest | null> {
  if (!has(w.tool, 'release-pr')) return null;
  const pr = w.releasePR();
  await w.merge(pr, method);
  await w.settle();
  return pr;
}

/** Land changes and ship the release they produce. */
export async function cycle(
  w: World,
  changes: Change[],
  method: MergeMethod = 'squash',
): Promise<PullRequest | null> {
  for (const c of changes) await w.land(c);
  return await shipPending(w, method);
}

/**
 * The commit on main where the repository's files first say `version`:
 * the commit a correct tag must point at.
 */
export async function releaseCommit(w: World, version: string): Promise<string | null> {
  const main = await w.head();
  const firstParent = await w.repo.git.revList(main, undefined, ['--first-parent']);
  let found: string | null = null;
  for (const sha of firstParent) {
    if (await w.tool.versionAt(w, sha) === version) found = sha;
    else if (found) break;
  }
  return found;
}

export async function expectReleased(w: World, version: string): Promise<void> {
  const tagName = w.tool.tagName(version);
  const tag = await w.tag(tagName);
  if (!tag) {
    throw new Expectation(
      `tag ${tagName} does not exist. Tags: ${
        (await w.tags()).join(', ') || 'none'
      }\n${w.runSummary()}`,
    );
  }
  const mainVersion = await w.tool.versionAt(w, 'refs/heads/main');
  w.expect(
    mainVersion === version,
    `files on main say ${mainVersion}, expected ${version}`,
  );
  const main = await w.head();
  const onMain = (await w.repo.git.revList(main, undefined, ['--first-parent'])).includes(
    tag.commit,
  );
  const expected = await releaseCommit(w, version);
  w.expect(expected, `no commit on main sets the version to ${version}`);
  if (has(w.tool, 'release-pr')) {
    // The tag must be on the commit that was reviewed and merged as the release.
    const info = await w.repo.git.commit(expected);
    const acceptable = [expected, ...(info && info.parents.length > 1 ? [info.parents[1]] : [])];
    w.expect(
      acceptable.includes(tag.commit),
      `tag ${tagName} points at ${tag.commit.slice(0, 7)}, but the release commit is ${
        expected.slice(0, 7)
      }`,
    );
  } else {
    // Tools that release from CI create the release commit themselves; the tag
    // must be on main, on a commit whose files carry the version.
    const at = await w.tool.versionAt(w, tag.commit);
    w.expect(
      onMain && at === version,
      `tag ${tagName} points at ${tag.commit.slice(0, 7)}, whose files say ${at}` +
        (onMain ? '' : ' and which is not on main'),
    );
  }
  if (has(w.tool, 'github-release')) {
    const release = w.release(tagName);
    w.expect(release, `no GitHub Release for ${tagName}\n${w.runSummary()}`);
    w.expect(!release.draft, `GitHub Release for ${tagName} is still a draft`);
  }
}

export async function expectNotReleased(w: World, version: string): Promise<void> {
  const tagName = w.tool.tagName(version);
  w.expect(!(await w.tag(tagName)), `tag ${tagName} exists but should not`);
  w.expect(!w.release(tagName), `GitHub Release ${tagName} exists but should not`);
}

/** Notes users see for a release: the GitHub Release body, else the changelog section. */
export async function releaseNotes(w: World, version: string): Promise<string> {
  const release = w.release(w.tool.tagName(version));
  if (release?.body) return release.body;
  return await changelogSection(w, version) ?? '';
}

/**
 * Whether a line is a changelog heading that names `version` as a whole word.
 * Compares text instead of building a regular expression from the version, so
 * no character of the version can be read as a pattern.
 */
export function headingNames(line: string, version: string): boolean {
  if (!/^#{1,3} /.test(line)) return false;
  const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);
  for (let at = line.indexOf(version); at >= 0; at = line.indexOf(version, at + 1)) {
    if (!isWord(line[at - 1]) && !isWord(line[at + version.length])) return true;
  }
  return false;
}

export async function changelogSection(
  w: World,
  version: string,
  ref = 'refs/heads/main',
): Promise<string | null> {
  const text = await w.file('CHANGELOG.md', ref);
  if (!text) return null;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => headingNames(l, version));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^#{1,2} \[?v?\d+\.\d+\.\d+/.test(l));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join('\n');
}

/**
 * Get a feature to the point where the next CI run performs the release, call
 * `arm`, then let CI run. For release-PR tools that point is the merge of the
 * release PR; for tools that release from CI directly it is the push itself.
 */
export async function releaseUnder(w: World, arm: () => void): Promise<void> {
  if (has(w.tool, 'release-pr')) {
    await w.land(feature('add export command'));
    await w.merge(w.releasePR());
    arm();
  } else {
    arm();
    await w.land(feature('add export command'), 'push', { settle: false });
  }
  await w.settle();
}

/** Number of changelog headings for a version. */
export async function changelogHeadings(w: World, version: string): Promise<number> {
  const text = await w.file('CHANGELOG.md') ?? '';
  return text.split('\n').filter((l) => headingNames(l, version)).length;
}

/** No run finished red. */
export function expectAllGreen(w: World): void {
  const failed = w.failedRuns();
  w.expect(failed.length === 0, `${failed.length} workflow run(s) failed\n${w.runSummary()}`);
}

/**
 * The outcome must not be silently wrong: if `ok` is false, at least one
 * workflow run must have failed so that someone finds out.
 */
export function expectLoudIfNot(w: World, ok: boolean, what: string): void {
  if (ok) return;
  w.expect(
    w.failedRuns().length > 0,
    `${what}, and every workflow run reported success\n${w.runSummary()}`,
  );
}
