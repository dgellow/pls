/**
 * Init Workflow - pls init
 *
 * Bootstrap pls for a new repository.
 * Detects existing version from manifest, creates versions.json and initial tag.
 */

import type { LocalGit } from '../clients/local-git.ts';
import type { PlsConfig } from '../domain/config.ts';
import type { ManifestPath } from '../domain/manifest.ts';
import { detectManifest } from '../domain/manifest.ts';
import { createInitialVersionsManifest } from '../domain/files.ts';
import { generateConfigFile } from '../domain/config.ts';
import { generateReleaseTagMessage } from '../domain/release-metadata.ts';
import { PlsError } from '../lib/error.ts';
import * as semver from '../lib/semver.ts';

export interface InitResult {
  version: string;
  tag: string;
  filesCreated: string[];
  dryRun: boolean;
}

export interface InitOptions {
  /** Override detected version */
  version?: string;
  /** Version file to track (any language, uses @pls-version marker) */
  versionFile?: string;
  /** Create config file with non-default settings */
  config?: Partial<PlsConfig>;
  /** Dry run mode */
  dryRun: boolean;
}

export interface DetectedProject {
  manifest: ManifestPath | null;
  version: string | null;
  workspaces: string[];
}

/**
 * Detect project type and version from manifest files.
 */
export async function detectProject(git: LocalGit): Promise<DetectedProject> {
  const manifest = await detectManifest((p) => git.readFile(p));

  if (!manifest) {
    return { manifest: null, version: null, workspaces: [] };
  }

  // Extract workspaces (manifest-specific)
  const workspaces = manifest.path === 'deno.json'
    ? extractWorkspaces(manifest.content)
    : manifest.path === 'package.json'
    ? extractNodeWorkspaces(manifest.content)
    : [];

  return {
    manifest: manifest.path,
    version: manifest.version,
    workspaces,
  };
}

/**
 * Extract workspace paths from deno.json.
 */
function extractWorkspaces(content: string): string[] {
  try {
    const json = JSON.parse(content);
    if (Array.isArray(json.workspace)) {
      return json.workspace.map((w: string) => w.replace(/^\.\//, ''));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Extract workspace paths from package.json.
 */
function extractNodeWorkspaces(content: string): string[] {
  try {
    const json = JSON.parse(content);
    if (Array.isArray(json.workspaces)) {
      // Handle simple array format
      return json.workspaces
        .filter((w: string) => !w.includes('*')) // Skip glob patterns for now
        .map((w: string) => w.replace(/^\.\//, ''));
    }
    if (json.workspaces?.packages && Array.isArray(json.workspaces.packages)) {
      // Handle object format with packages array
      return json.workspaces.packages
        .filter((w: string) => !w.includes('*'))
        .map((w: string) => w.replace(/^\.\//, ''));
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Execute pls init workflow.
 */
export async function initWorkflow(
  git: LocalGit,
  options: InitOptions,
): Promise<InitResult> {
  const { dryRun } = options;

  // 1. Check if already initialized
  const existingVersions = await git.readFile('.pls/versions.json');
  if (existingVersions) {
    throw new PlsError(
      'pls is already initialized. Found .pls/versions.json',
      'ALREADY_INITIALIZED',
    );
  }

  // 2. Detect project
  const project = await detectProject(git);

  // 3. Determine version
  let version = options.version;

  if (!version) {
    if (project.version) {
      version = project.version;
    } else {
      throw new PlsError(
        'Could not detect version. Use --version to specify initial version.\n' +
          'Example: pls init --version=1.0.0',
        'NO_VERSION_DETECTED',
      );
    }
  }

  // Validate version
  if (!semver.parse(version)) {
    throw new PlsError(
      `Invalid version: "${version}". Use semver format like "1.0.0" or "1.0.0-alpha.0"`,
      'INVALID_VERSION',
      { version },
    );
  }

  // 4. Check for version file
  const versionFile = options.versionFile;
  if (versionFile) {
    const content = await git.readFile(versionFile);
    if (!content) {
      throw new PlsError(
        `Version file not found: ${versionFile}`,
        'VERSION_FILE_NOT_FOUND',
        { path: versionFile },
      );
    }
    if (!content.includes('@pls-version')) {
      throw new PlsError(
        `Version file missing @pls-version marker.\n` +
          `Add a comment containing @pls-version on the line above your version declaration.\n` +
          `Examples:\n` +
          `  // @pls-version           (TypeScript/Go/Java)\n` +
          `  export const VERSION = '${version}';\n\n` +
          `  # @pls-version            (Python/Ruby/Shell)\n` +
          `  __version__ = '${version}'`,
        'VERSION_FILE_NO_MARKER',
        { path: versionFile },
      );
    }
  }

  // 5. Build files to create
  const filesCreated: string[] = [];
  const tag = `v${version}`;

  // versions.json
  const versionsContent = createInitialVersionsManifest(version, versionFile);
  filesCreated.push('.pls/versions.json');

  // Optional config file
  let configContent: string | null = null;
  if (options.config && Object.keys(options.config).length > 0) {
    configContent = generateConfigFile(options.config);
    filesCreated.push('.pls/config.json');
  }

  if (dryRun) {
    return {
      version,
      tag,
      filesCreated,
      dryRun: true,
    };
  }

  // 6. Write files
  await git.writeFile('.pls/versions.json', versionsContent);

  if (configContent) {
    await git.writeFile('.pls/config.json', configContent);
  }

  // 7. Check if tag already exists
  const tagExists = await git.tagExists(tag);

  if (!tagExists) {
    // Create annotated tag
    const tagMessage = generateReleaseTagMessage(
      { version, from: '0.0.0', type: 'patch' },
      `Initial release at ${version}`,
    );
    await git.createTag(tag, tagMessage);
  }

  return {
    version,
    tag,
    filesCreated,
    dryRun: false,
  };
}
