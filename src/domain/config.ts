/**
 * Configuration management for pls.
 *
 * Reads .pls/config.json and provides sensible defaults.
 * Convention over configuration - most projects won't need a config file.
 */

import { PlsError } from '../lib/error.ts';

/**
 * pls configuration schema.
 */
export interface PlsConfig {
  /** Where commits land (default: main) */
  baseBranch: string;
  /** Where releases merge to (default: main) */
  targetBranch: string;
  /** PR branch name (default: pls-release) */
  releaseBranch: string;
  /** Optional TypeScript version file */
  versionFile?: string;
  /** Branch strategy: simple (main only) or next (next → main) */
  strategy: 'simple' | 'next';
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: PlsConfig = {
  baseBranch: 'main',
  targetBranch: 'main',
  releaseBranch: 'pls-release',
  strategy: 'simple',
};

/**
 * Parse and validate configuration from JSON content.
 */
export function parseConfig(content: string): Partial<PlsConfig> {
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PlsError(
      'Invalid .pls/config.json: not valid JSON',
      'CONFIG_PARSE_ERROR',
    );
  }

  const config: Partial<PlsConfig> = {};

  // Validate and extract each field
  if ('baseBranch' in parsed) {
    if (typeof parsed.baseBranch !== 'string') {
      throw new PlsError(
        'Invalid config: baseBranch must be a string',
        'CONFIG_VALIDATION_ERROR',
        { field: 'baseBranch', value: parsed.baseBranch },
      );
    }
    config.baseBranch = parsed.baseBranch;
  }

  if ('targetBranch' in parsed) {
    if (typeof parsed.targetBranch !== 'string') {
      throw new PlsError(
        'Invalid config: targetBranch must be a string',
        'CONFIG_VALIDATION_ERROR',
        { field: 'targetBranch', value: parsed.targetBranch },
      );
    }
    config.targetBranch = parsed.targetBranch;
  }

  if ('releaseBranch' in parsed) {
    if (typeof parsed.releaseBranch !== 'string') {
      throw new PlsError(
        'Invalid config: releaseBranch must be a string',
        'CONFIG_VALIDATION_ERROR',
        { field: 'releaseBranch', value: parsed.releaseBranch },
      );
    }
    config.releaseBranch = parsed.releaseBranch;
  }

  if ('versionFile' in parsed) {
    if (typeof parsed.versionFile !== 'string') {
      throw new PlsError(
        'Invalid config: versionFile must be a string',
        'CONFIG_VALIDATION_ERROR',
        { field: 'versionFile', value: parsed.versionFile },
      );
    }
    config.versionFile = parsed.versionFile;
  }

  if ('strategy' in parsed) {
    if (parsed.strategy !== 'simple' && parsed.strategy !== 'next') {
      throw new PlsError(
        'Invalid config: strategy must be "simple" or "next"',
        'CONFIG_VALIDATION_ERROR',
        { field: 'strategy', value: parsed.strategy },
      );
    }
    config.strategy = parsed.strategy;
  }

  return config;
}

/**
 * Merge partial config with defaults.
 */
export function mergeConfig(partial: Partial<PlsConfig>): PlsConfig {
  const config = { ...DEFAULT_CONFIG, ...partial };

  // If strategy is 'next', adjust defaults accordingly
  if (partial.strategy === 'next' && !partial.baseBranch) {
    config.baseBranch = 'next';
  }

  return config;
}

/**
 * Load configuration from content, with defaults.
 */
export function loadConfig(content: string | null): PlsConfig {
  if (!content) {
    return DEFAULT_CONFIG;
  }

  const partial = parseConfig(content);
  return mergeConfig(partial);
}

/**
 * Generate default config file content.
 */
export function generateConfigFile(options?: Partial<PlsConfig>): string {
  const config: Record<string, unknown> = {};

  // Only include non-default values
  if (options?.baseBranch && options.baseBranch !== DEFAULT_CONFIG.baseBranch) {
    config.baseBranch = options.baseBranch;
  }
  if (options?.targetBranch && options.targetBranch !== DEFAULT_CONFIG.targetBranch) {
    config.targetBranch = options.targetBranch;
  }
  if (options?.releaseBranch && options.releaseBranch !== DEFAULT_CONFIG.releaseBranch) {
    config.releaseBranch = options.releaseBranch;
  }
  if (options?.versionFile) {
    config.versionFile = options.versionFile;
  }
  if (options?.strategy && options.strategy !== DEFAULT_CONFIG.strategy) {
    config.strategy = options.strategy;
  }

  return JSON.stringify(config, null, 2) + '\n';
}

/**
 * Detect strategy from branch configuration.
 */
export function detectStrategy(config: PlsConfig): 'simple' | 'next' {
  if (config.baseBranch !== config.targetBranch) {
    return 'next';
  }
  return 'simple';
}
