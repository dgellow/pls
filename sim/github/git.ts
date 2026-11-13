/**
 * Git plumbing on a bare repository.
 *
 * Every simulated GitHub repository is a real bare git repository on disk.
 * The REST API, the GraphQL API and the smart-HTTP endpoint all read and
 * write the same object store through this class, so SHAs, trees, tags and
 * merge results are produced by git itself, not invented by the simulator.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Identity {
  name: string;
  email: string;
  /** ISO 8601 date. Defaults to now. */
  date?: string;
}

export interface CommitInfo {
  sha: string;
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

export interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class GitError extends Error {
  constructor(public args: string[], public result: GitResult) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim()}`);
  }
}

export class BareRepo {
  /** Source of dates for objects created without an explicit one. */
  clock: () => string = () => new Date().toISOString();

  constructor(public readonly dir: string) {}

  static async init(dir: string, defaultBranch: string): Promise<BareRepo> {
    await Deno.mkdir(dir, { recursive: true });
    const repo = new BareRepo(dir);
    await repo.ok(['init', '--bare', '--quiet', `--initial-branch=${defaultBranch}`, '.']);
    // What github.com allows: pushes over HTTP, partial clones, fetch by SHA.
    for (
      const [key, value] of [
        ['http.receivepack', 'true'],
        ['uploadpack.allowFilter', 'true'],
        ['uploadpack.allowAnySHA1InWant', 'true'],
        ['receive.denyDeleteCurrent', 'false'],
        ['receive.hideRefs', 'refs/pull'],
        ['gc.auto', '0'],
      ]
    ) {
      await repo.ok(['config', key, value]);
    }
    return repo;
  }

  async raw(
    args: string[],
    opts: { stdin?: Uint8Array | string; env?: Record<string, string> } = {},
  ): Promise<{ code: number; stdout: Uint8Array; stderr: string }> {
    const command = new Deno.Command('git', {
      args,
      cwd: this.dir,
      stdin: opts.stdin === undefined ? 'null' : 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: { GIT_CONFIG_NOSYSTEM: '1', ...opts.env },
    });
    const child = command.spawn();
    if (opts.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(typeof opts.stdin === 'string' ? encoder.encode(opts.stdin) : opts.stdin);
      await writer.close();
    }
    const out = await child.output();
    return { code: out.code, stdout: out.stdout, stderr: decoder.decode(out.stderr) };
  }

  async run(
    args: string[],
    opts: { stdin?: Uint8Array | string; env?: Record<string, string> } = {},
  ): Promise<GitResult> {
    const r = await this.raw(args, opts);
    return { code: r.code, stdout: decoder.decode(r.stdout), stderr: r.stderr };
  }

  /** Run and return trimmed stdout; throw on non-zero exit. */
  async ok(
    args: string[],
    opts: { stdin?: Uint8Array | string; env?: Record<string, string> } = {},
  ): Promise<string> {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new GitError(args, r);
    return r.stdout.trim();
  }

  // --- refs ---

  /** SHA the ref points at, without peeling (a tag object SHA for annotated tags). */
  async refSha(ref: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', ref]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Commit SHA a ref or object resolves to, peeling tags. */
  async commitSha(rev: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async objectType(sha: string): Promise<'commit' | 'tree' | 'blob' | 'tag' | null> {
    const r = await this.run(['cat-file', '-t', sha]);
    return r.code === 0 ? (r.stdout.trim() as 'commit' | 'tree' | 'blob' | 'tag') : null;
  }

  /** All refs under a prefix as full name → raw SHA. */
  async refs(prefix = 'refs/'): Promise<Map<string, string>> {
    const out = await this.ok(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    const map = new Map<string, string>();
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [name, sha] = line.split(' ');
      map.set(name, sha);
    }
    return map;
  }

  async updateRef(ref: string, sha: string, oldSha?: string): Promise<void> {
    await this.ok(oldSha ? ['update-ref', ref, sha, oldSha] : ['update-ref', ref, sha]);
  }

  async deleteRef(ref: string): Promise<void> {
    await this.ok(['update-ref', '-d', ref]);
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const r = await this.run(['merge-base', '--is-ancestor', ancestor, descendant]);
    return r.code === 0;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const r = await this.run(['merge-base', a, b]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** Commits reachable from `to` and not from `from`, newest first. */
  async revList(to: string, from?: string, extra: string[] = []): Promise<string[]> {
    const range = from ? [`${from}..${to}`] : [to];
    const out = await this.ok(['rev-list', ...extra, ...range]);
    return out ? out.split('\n') : [];
  }

  // --- objects ---

  async commit(sha: string): Promise<CommitInfo | null> {
    const sep = '\x1f';
    const fmt = ['%H', '%T', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%B'].join(sep);
    const r = await this.run(['show', '-s', `--format=${fmt}`, `${sha}^{commit}`]);
    if (r.code !== 0) return null;
    const p = r.stdout.split(sep);
    return {
      sha: p[0],
      tree: p[1],
      parents: p[2] ? p[2].split(' ') : [],
      author: { name: p[3], email: p[4], date: p[5] },
      committer: { name: p[6], email: p[7], date: p[8] },
      message: p.slice(9).join(sep).replace(/\n+$/, ''),
    };
  }

  async blob(sha: string): Promise<Uint8Array | null> {
    const r = await this.raw(['cat-file', 'blob', sha]);
    return r.code === 0 ? r.stdout : null;
  }

  async writeBlob(content: Uint8Array): Promise<string> {
    return await this.ok(['hash-object', '-w', '--stdin'], { stdin: content });
  }

  async tree(treeish: string, recursive = false): Promise<TreeEntry[] | null> {
    const args = ['ls-tree', '-l', '-z'];
    if (recursive) args.push('-r', '-t');
    const r = await this.run([...args, treeish]);
    if (r.code !== 0) return null;
    const entries: TreeEntry[] = [];
    for (const rec of r.stdout.split('\0')) {
      if (!rec) continue;
      const [meta, path] = rec.split('\t');
      const [mode, type, sha, size] = meta.split(/\s+/);
      entries.push({
        path,
        mode,
        type: type as TreeEntry['type'],
        sha,
        size: size === '-' ? undefined : Number(size),
      });
    }
    return entries;
  }

  /** Entry for a path at a revision, or null. */
  async entryAt(rev: string, path: string): Promise<TreeEntry | null> {
    const r = await this.run(['ls-tree', '-l', '-z', rev, '--', path]);
    if (r.code !== 0 || !r.stdout) return null;
    const [meta, p] = r.stdout.split('\0')[0].split('\t');
    const [mode, type, sha, size] = meta.split(/\s+/);
    return {
      path: p,
      mode,
      type: type as TreeEntry['type'],
      sha,
      size: size === '-' ? undefined : Number(size),
    };
  }

  async fileAt(rev: string, path: string): Promise<Uint8Array | null> {
    const entry = await this.entryAt(rev, path);
    if (!entry || entry.type !== 'blob') return null;
    return await this.blob(entry.sha);
  }

  async textAt(rev: string, path: string): Promise<string | null> {
    const bytes = await this.fileAt(rev, path);
    return bytes ? decoder.decode(bytes) : null;
  }

  /**
   * Build a tree from an optional base tree plus changes, as the Git Data API does.
   * An entry with sha null removes the path.
   */
  async writeTree(
    baseTree: string | null,
    changes: Array<{ path: string; mode: string; sha: string | null }>,
  ): Promise<string> {
    const index = await Deno.makeTempFile({ prefix: 'sim-index-' });
    await Deno.remove(index);
    const env = { GIT_INDEX_FILE: index };
    try {
      if (baseTree) await this.ok(['read-tree', baseTree], { env });
      for (const c of changes) {
        if (c.sha === null) {
          // --force-remove needs a work tree; --index-info with mode 0 removes the entry.
          await this.ok(['update-index', '--index-info'], {
            env,
            stdin: `0 ${'0'.repeat(40)}\t${c.path}\n`,
          });
        } else {
          await this.ok(
            ['update-index', '--add', '--cacheinfo', `${c.mode},${c.sha},${c.path}`],
            { env },
          );
        }
      }
      return await this.ok(['write-tree'], { env });
    } finally {
      await Deno.remove(index).catch(() => {});
    }
  }

  async writeCommit(
    tree: string,
    parents: string[],
    message: string,
    author: Identity,
    committer: Identity = author,
  ): Promise<string> {
    const args = ['commit-tree', tree];
    for (const p of parents) args.push('-p', p);
    const now = this.clock();
    return await this.ok(args, {
      stdin: message.endsWith('\n') ? message : message + '\n',
      env: {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: author.date ?? now,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
        GIT_COMMITTER_DATE: committer.date ?? now,
      },
    });
  }

  /** Create an annotated tag object (not the ref). */
  async writeTag(
    name: string,
    object: string,
    type: string,
    message: string,
    tagger: Identity,
  ): Promise<string> {
    const ts = Math.floor(new Date(tagger.date ?? this.clock()).getTime() / 1000);
    const body = `object ${object}\ntype ${type}\ntag ${name}\n` +
      `tagger ${tagger.name} <${tagger.email}> ${ts} +0000\n\n${message}\n`;
    return await this.ok(['mktag'], { stdin: body });
  }

  async tagObject(
    sha: string,
  ): Promise<
    { object: string; type: string; tag: string; message: string; tagger: string } | null
  > {
    const r = await this.run(['cat-file', 'tag', sha]);
    if (r.code !== 0) return null;
    const [head, ...rest] = r.stdout.split('\n\n');
    const fields: Record<string, string> = {};
    for (const line of head.split('\n')) {
      const i = line.indexOf(' ');
      fields[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      object: fields.object,
      type: fields.type,
      tag: fields.tag,
      tagger: fields.tagger ?? '',
      message: rest.join('\n\n').replace(/\n$/, ''),
    };
  }

  /**
   * Three-way merge of two commits without a working tree.
   * Returns the merged tree, or null on conflict.
   */
  async mergeTrees(ours: string, theirs: string, base?: string): Promise<string | null> {
    const args = ['merge-tree', '--write-tree'];
    if (base) args.push(`--merge-base=${base}`);
    const r = await this.run([...args, ours, theirs]);
    if (r.code !== 0) return null;
    return r.stdout.split('\n')[0].trim();
  }

  /** Files changed between two commits (name-status). */
  async changedFiles(
    from: string,
    to: string,
  ): Promise<Array<{ status: string; filename: string }>> {
    const out = await this.ok(['diff', '--name-status', '-z', from, to]);
    const parts = out.split('\0').filter((p) => p.length > 0);
    const files: Array<{ status: string; filename: string }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      files.push({ status: parts[i], filename: parts[i + 1] });
    }
    return files;
  }
}
