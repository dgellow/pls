#!/usr/bin/env -S deno run -A

import { build, emptyDir } from 'jsr:@deno/dnt@0.41.3';

await emptyDir('./npm');

await build({
  entryPoints: ['./src/mod.ts', {
    kind: 'bin',
    name: 'pls',
    path: './src/cli.ts',
  }],
  outDir: './npm',
  shims: {
    deno: true,
  },
  package: {
    name: '@stainless/pls',
    version: Deno.args[0] || '0.1.0',
    description: 'A minimal, fast, and reliable release automation tool',
    keywords: ['release', 'automation', 'semantic-versioning', 'conventional-commits', 'cli'],
    license: 'MIT',
    repository: {
      type: 'git',
      url: 'git+https://github.com/stainless-api/pls.git',
    },
    bugs: {
      url: 'https://github.com/stainless-api/pls/issues',
    },
    bin: {
      pls: './esm/cli.js',
    },
    engines: {
      node: '>=18',
    },
  },
  postBuild() {
    // Copy additional files to npm directory
    Deno.copyFileSync('README.md', 'npm/README.md');
    Deno.copyFileSync('LICENSE', 'npm/LICENSE');
  },
  compilerOptions: {
    lib: ['ES2021', 'DOM'],
  },
});
