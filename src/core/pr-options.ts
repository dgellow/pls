/**
 * PR Options Block - Parse and generate version selection UI for release PRs.
 *
 * Format:
 * <!-- pls:options -->
 * - [x] **1.3.0** (minor) <!-- pls:v:1.3.0:minor -->
 * - [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
 * <!-- pls:options:end -->
 */

import type { VersionBump } from '../types.ts';

export interface VersionOption {
  version: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
  label: string;
  selected: boolean;
  disabled: boolean;
  disabledReason?: string;
}

export interface ParsedOptions {
  options: VersionOption[];
  selected: VersionOption | null;
}

const OPTIONS_START = '<!-- pls:options -->';
const OPTIONS_END = '<!-- pls:options:end -->';
const OPTION_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+)(?::disabled:(.+))? -->/;

/**
 * Parse pre-release stage from version string.
 */
function parsePrerelease(version: string): 'alpha' | 'beta' | 'rc' | 'stable' {
  if (version.includes('-alpha')) return 'alpha';
  if (version.includes('-beta')) return 'beta';
  if (version.includes('-rc')) return 'rc';
  return 'stable';
}

/**
 * Get base version without prerelease suffix.
 */
function getBaseVersion(version: string): string {
  return version.split('-')[0];
}

/**
 * Generate version options based on current version and calculated bump.
 */
export function generateOptions(
  currentVersion: string,
  bump: VersionBump,
): VersionOption[] {
  const options: VersionOption[] = [];
  const currentStage = parsePrerelease(currentVersion);
  const baseVersion = getBaseVersion(bump.to);

  // Main release option (from commit analysis)
  options.push({
    version: bump.to,
    type: bump.type === 'transition' ? 'transition' : bump.type as 'major' | 'minor' | 'patch',
    label: bump.type === 'transition' ? 'transition' : bump.type,
    selected: true, // Default selection
    disabled: false,
  });

  // Add prerelease options if not already a prerelease
  if (currentStage === 'stable') {
    // Offer alpha, beta, rc transitions
    const stages: Array<'alpha' | 'beta' | 'rc'> = ['alpha', 'beta', 'rc'];
    for (const stage of stages) {
      const prereleaseVersion = `${baseVersion}-${stage}.0`;
      if (prereleaseVersion !== bump.to) {
        options.push({
          version: prereleaseVersion,
          type: 'transition',
          label: stage,
          selected: false,
          disabled: false,
        });
      }
    }
  } else {
    // Already in prerelease - offer progression through stages
    const stageOrder = ['alpha', 'beta', 'rc', 'stable'] as const;
    const currentIndex = stageOrder.indexOf(currentStage);

    for (let i = currentIndex + 1; i < stageOrder.length; i++) {
      const stage = stageOrder[i];
      let targetVersion: string;

      if (stage === 'stable') {
        targetVersion = baseVersion;
      } else {
        targetVersion = `${baseVersion}-${stage}.0`;
      }

      if (targetVersion !== bump.to) {
        options.push({
          version: targetVersion,
          type: 'transition',
          label: stage,
          selected: false,
          disabled: false,
        });
      }
    }

    // Add disabled options for earlier stages
    for (let i = 0; i < currentIndex; i++) {
      const stage = stageOrder[i];
      const targetVersion = `${baseVersion}-${stage}.0`;
      options.push({
        version: targetVersion,
        type: 'transition',
        label: stage,
        selected: false,
        disabled: true,
        disabledReason: `already past ${stage}`,
      });
    }
  }

  return options;
}

/**
 * Generate the options block for PR description.
 */
export function generateOptionsBlock(options: VersionOption[]): string {
  const lines: string[] = [OPTIONS_START];

  for (const opt of options) {
    const checkbox = opt.selected ? '[x]' : '[ ]';
    let line: string;

    if (opt.disabled) {
      // Disabled options are struck through
      line =
        `- [ ] ~~${opt.version}~~ (${opt.label}) <!-- pls:v:${opt.version}:${opt.type}:disabled:${
          opt.disabledReason || 'unavailable'
        } -->`;
    } else if (opt.selected) {
      // Selected option is bold
      line =
        `- ${checkbox} **${opt.version}** (${opt.label}) <!-- pls:v:${opt.version}:${opt.type} -->`;
    } else {
      line =
        `- ${checkbox} ${opt.version} (${opt.label}) <!-- pls:v:${opt.version}:${opt.type} -->`;
    }

    lines.push(line);
  }

  lines.push(OPTIONS_END);
  return lines.join('\n');
}

/**
 * Parse the options block from PR description.
 */
export function parseOptionsBlock(body: string): ParsedOptions | null {
  const startIndex = body.indexOf(OPTIONS_START);
  const endIndex = body.indexOf(OPTIONS_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const optionsSection = body.substring(startIndex + OPTIONS_START.length, endIndex);
  const lines = optionsSection.split('\n').filter((line) => line.trim().startsWith('- ['));

  const options: VersionOption[] = [];
  let selected: VersionOption | null = null;

  for (const line of lines) {
    const markerMatch = line.match(OPTION_MARKER_REGEX);
    if (!markerMatch) continue;

    const [, version, type, disabledReason] = markerMatch;
    const isSelected = line.includes('[x]');
    const isDisabled = !!disabledReason;

    // Extract label from the line (text in parentheses before the marker)
    const labelMatch = line.match(/\(([^)]+)\)\s*<!--/);
    const label = labelMatch ? labelMatch[1] : type;

    const option: VersionOption = {
      version,
      type: type as VersionOption['type'],
      label,
      selected: isSelected,
      disabled: isDisabled,
      disabledReason: disabledReason,
    };

    options.push(option);

    if (isSelected && !isDisabled) {
      selected = option;
    }
  }

  return { options, selected };
}

/**
 * Update the options block in PR description with new selection.
 */
export function updateOptionsBlock(
  body: string,
  newSelectedVersion: string,
): string {
  const parsed = parseOptionsBlock(body);
  if (!parsed) return body;

  // Update selection
  const updatedOptions = parsed.options.map((opt) => ({
    ...opt,
    selected: opt.version === newSelectedVersion && !opt.disabled,
  }));

  // Generate new block
  const newBlock = generateOptionsBlock(updatedOptions);

  // Replace old block
  const startIndex = body.indexOf(OPTIONS_START);
  const endIndex = body.indexOf(OPTIONS_END) + OPTIONS_END.length;

  return body.substring(0, startIndex) + newBlock + body.substring(endIndex);
}

/**
 * Check if the selected option has changed between two PR bodies.
 */
export function hasSelectionChanged(oldBody: string, newBody: string): boolean {
  const oldParsed = parseOptionsBlock(oldBody);
  const newParsed = parseOptionsBlock(newBody);

  if (!oldParsed || !newParsed) return false;

  const oldSelected = oldParsed.selected?.version;
  const newSelected = newParsed.selected?.version;

  return oldSelected !== newSelected;
}

/**
 * Get the selected version from PR description.
 */
export function getSelectedVersion(body: string): string | null {
  const parsed = parseOptionsBlock(body);
  return parsed?.selected?.version ?? null;
}
