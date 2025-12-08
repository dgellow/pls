/**
 * PR body generation and parsing - version selection UI.
 *
 * Pure functions, no I/O.
 *
 * Format in PR body:
 * ```
 * <!-- pls:options -->
 * **Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->
 *
 * Switch to:
 * - [ ] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
 * - [ ] 1.2.4 (patch) <!-- pls:v:1.2.4:patch -->
 * <!-- pls:options:end -->
 * ```
 */

import type { VersionBump, VersionOption, VersionSelection } from './types.ts';
import * as semver from '../lib/semver.ts';

const OPTIONS_START = '<!-- pls:options -->';
const OPTIONS_END = '<!-- pls:options:end -->';
const CURRENT_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+):current -->/;
const OPTION_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+)(?::disabled:(.+))? -->/;

/**
 * Generate version options based on calculated bump.
 */
export function generateOptions(
  bump: VersionBump,
): VersionOption[] {
  const options: VersionOption[] = [];
  const currentStage = semver.getStage(bump.from);
  const baseVersion = semver.getBase(bump.to);

  // Main option (from commit analysis) - always selected by default
  options.push({
    version: bump.to,
    type: bump.type,
    label: bump.type,
    selected: true,
    disabled: false,
  });

  // Add prerelease options if currently stable
  if (currentStage === 'stable') {
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
    // In prerelease - offer progression through stages
    const stageOrder = ['alpha', 'beta', 'rc', 'stable'] as const;
    const currentIndex = stageOrder.indexOf(currentStage);

    // Future stages (enabled)
    for (let i = currentIndex + 1; i < stageOrder.length; i++) {
      const stage = stageOrder[i];
      const targetVersion = stage === 'stable'
        ? baseVersion
        : `${baseVersion}-${stage}.0`;

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

    // Past stages (disabled)
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
 * Generate the options block for PR body.
 */
export function generateOptionsBlock(options: VersionOption[]): string {
  const lines: string[] = [OPTIONS_START];

  // Find selected option
  const selected = options.find((opt) => opt.selected && !opt.disabled);
  const alternatives = options.filter((opt) => !opt.selected || opt.disabled);

  // Current selection (no checkbox)
  if (selected) {
    lines.push(
      `**Current: ${selected.version}** (${selected.label}) <!-- pls:v:${selected.version}:${selected.type}:current -->`,
    );
  }

  // Alternatives (with checkboxes)
  if (alternatives.length > 0) {
    lines.push('');
    lines.push('Switch to:');

    for (const opt of alternatives) {
      if (opt.disabled) {
        lines.push(
          `- [ ] ~~${opt.version}~~ (${opt.label}) <!-- pls:v:${opt.version}:${opt.type}:disabled:${opt.disabledReason || 'unavailable'} -->`,
        );
      } else {
        lines.push(
          `- [ ] ${opt.version} (${opt.label}) <!-- pls:v:${opt.version}:${opt.type} -->`,
        );
      }
    }
  }

  lines.push(OPTIONS_END);
  return lines.join('\n');
}

/**
 * Parse version selection from PR body.
 */
export function parseOptionsBlock(body: string): VersionSelection | null {
  const startIndex = body.indexOf(OPTIONS_START);
  const endIndex = body.indexOf(OPTIONS_END);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const optionsSection = body.substring(
    startIndex + OPTIONS_START.length,
    endIndex,
  );
  const lines = optionsSection.split('\n');

  const options: VersionOption[] = [];
  let currentOption: VersionOption | null = null;
  let checkedAlternative: VersionOption | null = null;

  for (const line of lines) {
    // Check for current selection marker
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

    // Check for checkbox options
    if (!line.trim().startsWith('- [')) continue;

    const markerMatch = line.match(OPTION_MARKER_REGEX);
    if (!markerMatch) continue;

    const [, version, type, disabledReason] = markerMatch;
    const isChecked = line.includes('[x]') || line.includes('[X]');
    const isDisabled = !!disabledReason;

    const labelMatch = line.match(/\(([^)]+)\)\s*<!--/);
    const label = labelMatch ? labelMatch[1] : type;

    const option: VersionOption = {
      version,
      type: type as VersionOption['type'],
      label,
      selected: isChecked,
      disabled: isDisabled,
      disabledReason,
    };

    options.push(option);

    // Track first checked alternative
    if (isChecked && !isDisabled && !checkedAlternative) {
      checkedAlternative = option;
    }
  }

  // If user checked an alternative, that's the selection
  const selected = checkedAlternative || currentOption;

  return { options, selected };
}

/**
 * Get selected version from PR body.
 */
export function getSelectedVersion(body: string): string | null {
  const parsed = parseOptionsBlock(body);
  return parsed?.selected?.version ?? null;
}

/**
 * Generate complete PR body.
 */
export function generatePRBody(
  bump: VersionBump,
  changelog: string,
): string {
  const options = generateOptions(bump);
  const optionsBlock = generateOptionsBlock(options);

  return `## Release ${bump.to}

This PR was automatically created by pls.

### Changes

${changelog}

---
*Merging this PR will create a GitHub release and tag.*

<details>
<summary>Version Selection</summary>

Select a version option below. The branch will be updated when the workflow runs.

${optionsBlock}

</details>`;
}

/**
 * Update PR body with new selection.
 */
export function updatePRBody(
  body: string,
  newVersion: string,
): string {
  const parsed = parseOptionsBlock(body);
  if (!parsed) return body;

  // Update selection
  const updatedOptions = parsed.options.map((opt) => ({
    ...opt,
    selected: opt.version === newVersion && !opt.disabled,
  }));

  // Generate new options block
  const newOptionsBlock = generateOptionsBlock(updatedOptions);

  // Replace options block
  const startIndex = body.indexOf(OPTIONS_START);
  const endIndex = body.indexOf(OPTIONS_END) + OPTIONS_END.length;

  let updatedBody = body.substring(0, startIndex) +
    newOptionsBlock +
    body.substring(endIndex);

  // Update header
  updatedBody = updatedBody.replace(
    /^## Release \d+\.\d+\.\d+(?:-[a-z]+\.\d+)?/m,
    `## Release ${newVersion}`,
  );

  return updatedBody;
}
