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
// ":chosen" marks a current version a person picked, as opposed to the one
// calculated from the commits. A chosen version stays when new commits arrive.
const CURRENT_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+):current(:chosen)? -->/;
const CHOSEN_NOTE = '_Chosen by hand: it stays until another option is ticked._';
const OPTION_MARKER_REGEX = /<!-- pls:v:([^:]+):([^:]+)(?::disabled:(.+))? -->/;

/**
 * Generate version options based on calculated bump.
 *
 * `bump.to` is the version calculated from the commits. `selectedVersion` is
 * the version the release PR currently proposes; it differs from `bump.to`
 * when a person chose another option.
 */
export function generateOptions(
  bump: VersionBump,
  selectedVersion: string = bump.to,
): VersionOption[] {
  const options: VersionOption[] = [];
  const currentStage = semver.getStage(bump.from);
  const baseVersion = semver.getBase(bump.to);

  // Main option (from commit analysis)
  options.push({
    version: bump.to,
    type: bump.type,
    label: bump.type,
    selected: false,
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

    // The other bump types: commit messages are sometimes wrong about the
    // size of a change, and a person has to be able to say so.
    const parsedFrom = semver.parse(bump.from);
    for (const type of ['major', 'minor', 'patch'] as const) {
      const version = semver.bump(bump.from, type);
      if (options.some((opt) => opt.version === version)) continue;
      options.push({
        version,
        type,
        // For pre-1.0, the major bump is the deliberate step to a stable 1.0.0
        label: type === 'major' && parsedFrom?.major === 0 ? 'stable' : type,
        selected: false,
        disabled: false,
      });
    }
  } else {
    // In prerelease - offer progression through stages
    const stageOrder = ['alpha', 'beta', 'rc', 'stable'] as const;
    const currentIndex = stageOrder.indexOf(currentStage);

    // Future stages (enabled)
    for (let i = currentIndex + 1; i < stageOrder.length; i++) {
      const stage = stageOrder[i];
      const targetVersion = stage === 'stable' ? baseVersion : `${baseVersion}-${stage}.0`;

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

  // The selected version is shown as current. One that is not in the list
  // above (a prerelease of another bump type, say) is added so it can be.
  let selected = options.find((opt) => opt.version === selectedVersion && !opt.disabled);
  if (!selected) {
    const stage = semver.getStage(selectedVersion);
    selected = {
      version: selectedVersion,
      type: stage === 'stable' ? bump.type : 'transition',
      label: stage === 'stable' ? bump.type : stage,
      selected: false,
      disabled: false,
    };
    options.push(selected);
  }
  selected.selected = true;

  return options;
}

/**
 * Generate the options block for PR body.
 */
export function generateOptionsBlock(options: VersionOption[], chosen = false): string {
  const lines: string[] = [OPTIONS_START];

  // Find selected option
  const selected = options.find((opt) => opt.selected && !opt.disabled);
  const alternatives = options.filter((opt) => !opt.selected || opt.disabled);

  // Current selection (no checkbox)
  if (selected) {
    lines.push(
      `**Current: ${selected.version}** (${selected.label}) <!-- pls:v:${selected.version}:${selected.type}:current${
        chosen ? ':chosen' : ''
      } -->`,
    );
    if (chosen) lines.push(CHOSEN_NOTE);
  }

  // Alternatives (with checkboxes)
  if (alternatives.length > 0) {
    lines.push('');
    lines.push('Switch to:');

    for (const opt of alternatives) {
      if (opt.disabled) {
        lines.push(
          `- [ ] ~~${opt.version}~~ (${opt.label}) <!-- pls:v:${opt.version}:${opt.type}:disabled:${
            opt.disabledReason || 'unavailable'
          } -->`,
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
  let currentChosen = false;
  let checkedAlternative: VersionOption | null = null;

  for (const line of lines) {
    // Check for current selection marker
    const currentMatch = line.match(CURRENT_MARKER_REGEX);
    if (currentMatch) {
      const [, version, type, chosenFlag] = currentMatch;
      currentChosen = !!chosenFlag;
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
  const chosen = checkedAlternative !== null || (currentOption !== null && currentChosen);

  return { options, selected, chosen };
}

/**
 * Get selected version from PR body.
 */
export function getSelectedVersion(body: string): string | null {
  const parsed = parseOptionsBlock(body);
  return parsed?.selected?.version ?? null;
}

/**
 * Get the version a person chose in the PR body: a ticked checkbox, or a
 * current version marked as chosen by an earlier sync. Returns null when the
 * current version is the calculated one, which is recalculated on each run.
 *
 * The body can be edited by anyone who can edit the PR, so the caller checks
 * the result against the versions pls would propose (see nextVersions).
 */
export function getUserOverride(body: string): string | null {
  const parsed = parseOptionsBlock(body);
  if (!parsed?.selected || !parsed.chosen) return null;
  return parsed.selected.version;
}

/**
 * Generate complete PR body.
 */
export function generatePRBody(
  bump: VersionBump,
  changelog: string,
  chosenVersion: string | null = null,
): string {
  const version = chosenVersion ?? bump.to;
  const options = generateOptions(bump, version);
  const optionsBlock = generateOptionsBlock(options, chosenVersion !== null);

  return `## Release ${version}

This PR was automatically created by pls.

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

  // Generate new options block. The version was picked by a person, so it is
  // marked as chosen and survives the next recalculation.
  const newOptionsBlock = generateOptionsBlock(updatedOptions, true);

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

/**
 * Generate PR body for bootstrap (no version selection).
 */
export function generateBootstrapPRBody(
  version: string,
  manifest: string,
): string {
  return `## Initialize pls

This PR initializes pls for version tracking.

### What this does
- Creates \`.pls/versions.json\` with version \`${version}\` (detected from \`${manifest}\`)

---
*Merging this PR will initialize pls. Future releases will work automatically.*`;
}
