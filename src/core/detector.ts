import type { Commit, Release } from '../types.ts';
import { PlsError } from '../types.ts';

export class Detector {
  async getCommitsSince(since: string | null): Promise<Commit[]> {
    try {
      // Use %x00 (null byte) as delimiter since it can't appear in commit messages
      const DELIM = '\x00';
      const args = [
        'log',
        `--format=%H${DELIM}%s${DELIM}%an${DELIM}%aI`,
        '--no-merges',
      ];

      if (since) {
        args.push(`${since}..HEAD`);
      } else {
        // If no previous release, get all commits
        args.push('HEAD');
      }

      const command = new Deno.Command('git', { args });
      const { code, stdout, stderr } = await command.output();

      if (code !== 0) {
        const error = new TextDecoder().decode(stderr);
        throw new PlsError(
          `Git command failed: ${error}`,
          'GIT_ERROR',
        );
      }

      const output = new TextDecoder().decode(stdout);
      const lines = output.trim().split('\n').filter((line) => line);

      return lines.map((line) => {
        const [sha, message, author, date] = line.split(DELIM);
        return {
          sha,
          message,
          author,
          date: new Date(date),
        };
      });
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to get commits: ${error instanceof Error ? error.message : String(error)}`,
        'DETECTOR_ERROR',
        error,
      );
    }
  }

  async getCurrentSha(): Promise<string> {
    try {
      const command = new Deno.Command('git', {
        args: ['rev-parse', 'HEAD'],
      });
      const { code, stdout, stderr } = await command.output();

      if (code !== 0) {
        const error = new TextDecoder().decode(stderr);
        throw new PlsError(
          `Failed to get current SHA: ${error}`,
          'GIT_ERROR',
        );
      }

      return new TextDecoder().decode(stdout).trim();
    } catch (error) {
      if (error instanceof PlsError) throw error;
      throw new PlsError(
        `Failed to get current SHA: ${error instanceof Error ? error.message : String(error)}`,
        'DETECTOR_ERROR',
        error,
      );
    }
  }

  async getRepoInfo(): Promise<{ owner: string; repo: string } | null> {
    try {
      const command = new Deno.Command('git', {
        args: ['remote', 'get-url', 'origin'],
      });
      const { code, stdout } = await command.output();

      if (code !== 0) {
        return null;
      }

      const url = new TextDecoder().decode(stdout).trim();

      // Parse GitHub URL (https or ssh)
      const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(\.git)?$/);
      if (httpsMatch) {
        return {
          owner: httpsMatch[1],
          repo: httpsMatch[2],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  async detectChanges(lastRelease: Release | null): Promise<{
    commits: Commit[];
    currentSha: string;
    hasChanges: boolean;
  }> {
    const currentSha = await this.getCurrentSha();

    if (lastRelease && lastRelease.sha === currentSha) {
      return {
        commits: [],
        currentSha,
        hasChanges: false,
      };
    }

    const commits = await this.getCommitsSince(lastRelease?.sha || null);

    return {
      commits,
      currentSha,
      hasChanges: commits.length > 0,
    };
  }
}
