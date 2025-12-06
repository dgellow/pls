/**
 * PR Options Block - Parse and generate version selection UI for release PRs.
 *
 * Format:
 * <!-- pls:options -->
 * **Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->
 *
 * Switch to:
 * - [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
 * - [ ] 1.3.0-beta.0 (beta) <!-- pls:v:1.3.0-beta.0:transition -->
 * <!-- pls:options:end -->
 *
 * The current selection has no checkbox (just display).
 * Only alternatives have checkboxes to avoid double-click issues.
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
 * Current selection shown without checkbox, alternatives have checkboxes.
 */
export function generateOptionsBlock(options: VersionOption[]): string {
  const lines: string[] = [OPTIONS_START];

  // Find the selected option
  const selected = options.find((opt) => opt.selected && !opt.disabled);
  const alternatives = options.filter((opt) => !opt.selected || opt.disabled);

  // Show current selection without checkbox
  if (selected) {
    lines.push(
      `**Current: ${selected.version}** (${selected.label}) <!-- pls:v:${selected.version}:${selected.type}:current -->`,
    );
  }

  // Show alternatives with checkboxes (if any)
  if (alternatives.length > 0) {
    lines.push('');
    lines.push('Switch to:');

    for (const opt of alternatives) {
      let line: string;

      if (opt.disabled) {
        // Disabled options are struck through
        line =
          `- [ ] ~~${opt.version}~~ (${opt.label}) <!-- pls:v:${opt.version}:${opt.type}:disabled:${
            opt.disabledReason || 'unavailable'
          } -->`;
      } else {
        line = `- [ ] ${opt.version} (${opt.label}) <!-- pls:v:${opt.version}:${opt.type} -->`;
      }

      lines.push(line);
    }
  }

  lines.push(OPTIONS_END);
  return lines.join('\n');
}

// Regex to match current marker: <!-- pls:v:VERSION:TYPE:current -->
const CURRENT_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+):current -->/;

/**
 * Parse the options block from PR description.
 * Handles both:
 * - Current selection (no checkbox, marked with :current)
 * - Alternatives (checkboxes, checked = user wants to switch)
 */
export function parseOptionsBlock(body: string): ParsedOptions | null {
  const startIndex = body.indexOf(OPTIONS_START);
  const endIndex = body.indexOf(OPTIONS_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const optionsSection = body.substring(startIndex + OPTIONS_START.length, endIndex);
  const lines = optionsSection.split('\n');

  const options: VersionOption[] = [];
  let currentOption: VersionOption | null = null;
  let firstCheckedAlternative: VersionOption | null = null;

  for (const line of lines) {
    // Check for current selection marker (no checkbox)
    const currentMatch = line.match(CURRENT_MARKER_REGEX);
    if (currentMatch) {
      const [, version, type] = currentMatch;
      const labelMatch = line.match(/\(([^)]+)\)\s*<!--/);
      const label = labelMatch ? labelMatch[1] : type;

      const option: VersionOption = {
        version,
        type: type as VersionOption['type'],
        label,
        selected: true,
        disabled: false,
      };

      options.push(option);
      currentOption = option;
      continue;
    }

    // Check for checkbox options (alternatives)
    if (!line.trim().startsWith('- [')) continue;

    const markerMatch = line.match(OPTION_MARKER_REGEX);
    if (!markerMatch) continue;

    const [, version, type, disabledReason] = markerMatch;
    const isChecked = line.includes('[x]');
    const isDisabled = !!disabledReason;

    // Extract label from the line (text in parentheses before the marker)
    const labelMatch = line.match(/\(([^)]+)\)\s*<!--/);
    const label = labelMatch ? labelMatch[1] : type;

    const option: VersionOption = {
      version,
      type: type as VersionOption['type'],
      label,
      selected: isChecked, // Checked alternative = user wants to switch
      disabled: isDisabled,
      disabledReason: disabledReason,
    };

    options.push(option);

    // Track first checked alternative (user wants to switch to this)
    if (isChecked && !isDisabled && !firstCheckedAlternative) {
      firstCheckedAlternative = option;
    }
  }

  // If user checked an alternative, that's the selection; otherwise keep current
  const selected = firstCheckedAlternative || currentOption;

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
