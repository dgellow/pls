#!/usr/bin/env -S deno run -A
/**
 * Build script for publishing the CLI to npm as @dgellow/pls
 * Creates platform-specific packages like esbuild does:
 *   @dgellow/pls              - Main package with wrapper (tiny)
 *   @dgellow/pls-linux-x64    - Linux x64 binary
 *   @dgellow/pls-linux-arm64  - Linux ARM64 binary
 *   @dgellow/pls-darwin-x64   - macOS Intel binary
 *   @dgellow/pls-darwin-arm64 - macOS Apple Silicon binary
 *   @dgellow/pls-win32-x64    - Windows x64 binary
 *
 * Usage:
 *   deno run -A scripts/build_npm.ts              # Build all platforms
 *   deno run -A scripts/build_npm.ts --platform linux-x64  # Build only linux-x64
 */

import { parseArgs } from '@std/cli/parse-args';

const args = parseArgs(Deno.args, {
  string: ['platform'],
});

// Get version from deno.json
const denoJson = JSON.parse(await Deno.readTextFile('./deno.json'));
const version = (args._[0] as string) || denoJson.version;

if (!version) {
  console.error(
    'Error: No version specified. Pass version as argument or ensure deno.json has a version field.',
  );
  Deno.exit(1);
}

console.log(`Building @dgellow/pls version ${version}...`);

// Clean output directory
try {
  await Deno.remove('./npm', { recursive: true });
} catch {
  // Directory doesn't exist, ignore
}

// Platform configurations
const allPlatforms = [
  {
    target: 'x86_64-unknown-linux-gnu',
    pkg: '@dgellow/pls-linux-x64',
    os: 'linux',
    cpu: 'x64',
    binName: 'pls',
  },
  {
    target: 'aarch64-unknown-linux-gnu',
    pkg: '@dgellow/pls-linux-arm64',
    os: 'linux',
    cpu: 'arm64',
    binName: 'pls',
  },
  {
    target: 'x86_64-apple-darwin',
    pkg: '@dgellow/pls-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    binName: 'pls',
  },
  {
    target: 'aarch64-apple-darwin',
    pkg: '@dgellow/pls-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    binName: 'pls',
  },
  {
    target: 'x86_64-pc-windows-msvc',
    pkg: '@dgellow/pls-win32-x64',
    os: 'win32',
    cpu: 'x64',
    binName: 'pls.exe',
  },
];

// Filter platforms if --platform flag is provided
const platforms = args.platform
  ? allPlatforms.filter((p) => `${p.os}-${p.cpu}` === args.platform)
  : allPlatforms;

if (platforms.length === 0) {
  console.error(`Error: Unknown platform "${args.platform}"`);
  console.error('Valid platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64');
  Deno.exit(1);
}

// Create platform-specific packages
for (const platform of platforms) {
  const pkgDir = `./npm/${platform.pkg.replace('@dgellow/', '')}`;
  await Deno.mkdir(`${pkgDir}/bin`, { recursive: true });

  console.log(`[build] Compiling for ${platform.target}...`);
  const cmd = new Deno.Command('deno', {
    args: [
      'compile',
      '--allow-read',
      '--allow-write',
      '--allow-net',
      '--allow-env',
      '--allow-run',
      '--target',
      platform.target,
      '--output',
      `${pkgDir}/bin/${platform.binName}`,
      './src/cli/main.ts',
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  });

  const result = await cmd.output();
  if (!result.success) {
    console.error(`Failed to compile for ${platform.target}`);
    Deno.exit(1);
  }

  // Create package.json for this platform
  const pkgJson = {
    name: platform.pkg,
    version,
    description: `Platform-specific binary for @dgellow/pls (${platform.os}-${platform.cpu})`,
    license: 'Elastic-2.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/dgellow/pls.git',
    },
    os: [platform.os],
    cpu: [platform.cpu],
  };

  await Deno.writeTextFile(`${pkgDir}/package.json`, JSON.stringify(pkgJson, null, 2) + '\n');

  // Show binary size
  const stat = await Deno.stat(`${pkgDir}/bin/${platform.binName}`);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`  ${platform.pkg}: ${sizeMB} MB`);
}

// Create main @dgellow/pls package
console.log('\n[build] Creating main @dgellow/pls package...');
const mainPkgDir = './npm/pls';
await Deno.mkdir(mainPkgDir, { recursive: true });

// Create the JavaScript wrapper
const wrapperCode = `#!/usr/bin/env node
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const platform = process.platform;
const arch = process.arch;

const PLATFORMS = {
  "linux-x64": "pls-linux-x64",
  "linux-arm64": "pls-linux-arm64",
  "darwin-x64": "pls-darwin-x64",
  "darwin-arm64": "pls-darwin-arm64",
  "win32-x64": "pls-win32-x64",
};

const key = \`\${platform}-\${arch}\`;
const pkgSuffix = PLATFORMS[key];

if (!pkgSuffix) {
  console.error(\`Unsupported platform: \${key}\`);
  console.error("Please use Deno directly: deno run -A jsr:@dgellow/pls");
  process.exit(1);
}

const binName = platform === "win32" ? "pls.exe" : "pls";
let binPath;

// Try multiple locations:
// 1. Sibling directory (for local dev/testing)
// 2. node_modules (for installed package)
const locations = [
  // Local dev: ../pls-linux-x64/bin/pls
  path.join(__dirname, "..", pkgSuffix, "bin", binName),
  // Installed: node_modules/@dgellow/pls-linux-x64/bin/pls
  path.join(__dirname, "..", "..", pkgSuffix, "bin", binName),
];

for (const loc of locations) {
  if (fs.existsSync(loc)) {
    binPath = loc;
    break;
  }
}

if (!binPath) {
  // Try require.resolve as fallback
  try {
    const pkgPath = require.resolve(\`@dgellow/\${pkgSuffix}/package.json\`);
    const pkgDir = path.dirname(pkgPath);
    binPath = path.join(pkgDir, "bin", binName);
  } catch (e) {
    console.error(\`Failed to find binary for \${key}\`);
    console.error("Try reinstalling: npm install @dgellow/pls");
    process.exit(1);
  }
}

try {
  execFileSync(binPath, process.argv.slice(2), { stdio: "inherit" });
} catch (e) {
  if (e.status !== undefined) {
    process.exit(e.status);
  }
  throw e;
}
`;

await Deno.writeTextFile(`${mainPkgDir}/pls.js`, wrapperCode);

// Create main package.json with optionalDependencies
const mainPkgJson = {
  name: '@dgellow/pls',
  version,
  description: 'A minimal, fast, and reliable release automation tool',
  license: 'Elastic-2.0',
  repository: {
    type: 'git',
    url: 'git+https://github.com/dgellow/pls.git',
  },
  bugs: {
    url: 'https://github.com/dgellow/pls/issues',
  },
  homepage: 'https://github.com/dgellow/pls#readme',
  keywords: ['release', 'automation', 'semantic-versioning', 'conventional-commits', 'cli'],
  bin: {
    pls: './pls.js',
  },
  files: ['pls.js'],
  engines: {
    node: '>=14.0.0',
  },
  optionalDependencies: {
    '@dgellow/pls-linux-x64': version,
    '@dgellow/pls-linux-arm64': version,
    '@dgellow/pls-darwin-x64': version,
    '@dgellow/pls-darwin-arm64': version,
    '@dgellow/pls-win32-x64': version,
  },
};

await Deno.writeTextFile(`${mainPkgDir}/package.json`, JSON.stringify(mainPkgJson, null, 2) + '\n');

// Copy README and LICENSE to main package
await Deno.copyFile('LICENSE', `${mainPkgDir}/LICENSE`);
await Deno.copyFile('README.md', `${mainPkgDir}/README.md`);

console.log(`
Build complete! Output in ./npm

Packages created:
  npm/pls/             - @dgellow/pls (main package)
  npm/pls-linux-x64/   - @dgellow/pls-linux-x64
  npm/pls-linux-arm64/ - @dgellow/pls-linux-arm64
  npm/pls-darwin-x64/  - @dgellow/pls-darwin-x64
  npm/pls-darwin-arm64/ - @dgellow/pls-darwin-arm64
  npm/pls-win32-x64/   - @dgellow/pls-win32-x64

To publish all packages:
  for dir in npm/*/; do (cd "$dir" && npm publish --access public); done
`);
