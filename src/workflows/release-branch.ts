/**
 * The release branch is generated: prep and sync replace it with one commit
 * built on the base branch. A commit someone else pushed to it is lost when
 * that happens. These helpers find such commits beforehand and say so on the
 * release PR afterwards, so that an edit is never dropped without a word.
 */

import { hasReleaseMetadata } from '../domain/release-metadata.ts';
import type { CodeHost, HostCommit } from '../domain/vcs.ts';

/**
 * Commits on the release branch that pls did not generate.
 *
 * Merge commits are left out: a merge of the base branch (GitHub's "Update
 * branch" button) carries no change of its own.
 */
export async function findForeignCommits(
  host: CodeHost,
  baseBranch: string,
  releaseBranch: string,
): Promise<HostCommit[]> {
  const ahead = await host.getCommitsAhead(baseBranch, releaseBranch);
  return ahead.filter((c) => c.parents.length === 1 && !hasReleaseMetadata(c.message));
}

/**
 * Tell the PR's readers which commits were discarded and where such a change
 * belongs. A failure to post the comment is reported on the console and does
 * not fail the run: the branch has already been rebuilt.
 */
export async function reportDiscardedCommits(
  host: CodeHost,
  prNumber: number,
  baseBranch: string,
  discarded: HostCommit[],
): Promise<void> {
  if (discarded.length === 0) return;

  const list = discarded
    .map((c) => `- \`${c.rev.slice(0, 7)}\` ${c.message.split('\n')[0]}`)
    .join('\n');
  const body =
    `pls rebuilt this branch and discarded ${
      discarded.length === 1 ? 'a commit' : `${discarded.length} commits`
    } it did not make:\n\n${list}\n\n` +
    `The release branch is generated. It is replaced on every push to \`${baseBranch}\` and ` +
    `whenever a version is selected, so changes pushed to it do not last.\n\n` +
    `To keep a change, land it on \`${baseBranch}\`. The changelog entry is written from the ` +
    `commit messages on \`${baseBranch}\`; \`CHANGELOG.md\` can also be edited on ` +
    `\`${baseBranch}\` after the release, and pls keeps those edits.`;

  try {
    await host.commentOnPR(prNumber, body);
  } catch (error) {
    console.warn(
      `⚠️  Could not comment on PR #${prNumber} (${
        error instanceof Error ? error.message.split('\n')[0] : error
      }). The comment would have said:\n${body}`,
    );
  }
}
