/**
 * Structured release metadata embedded in commit messages.
 *
 * Format:
 * ```
 * chore: release v1.2.3
 *
 * ---pls-release---
 * version: 1.2.3
 * from: 1.2.2
 * type: minor
 * ---pls-release---
 * ```
 *
 * This avoids fragile regex parsing of commit messages.
 */

export interface ReleaseMetadata {
  version: string;
  from: string;
  type: 'major' | 'minor' | 'patch' | 'transition';
}

const DELIMITER = '---pls-release---';

/**
 * Generate a commit message with embedded release metadata.
 */
export function generateReleaseCommitMessage(metadata: ReleaseMetadata): string {
  const tag = `v${metadata.version}`;
  const metadataBlock = [
    DELIMITER,
    `version: ${metadata.version}`,
    `from: ${metadata.from}`,
    `type: ${metadata.type}`,
    DELIMITER,
  ].join('\n');

  return `chore: release ${tag}\n\n${metadataBlock}`;
}

/**
 * Parse release metadata from a commit message.
 * Returns null if no valid metadata block is found.
 */
export function parseReleaseMetadata(commitMessage: string): ReleaseMetadata | null {
  // Find the metadata block between delimiters
  const delimiterRegex = new RegExp(
    `${escapeRegex(DELIMITER)}\\n([\\s\\S]*?)\\n${escapeRegex(DELIMITER)}`,
  );
  const match = commitMessage.match(delimiterRegex);

  if (!match) {
    return null;
  }

  const metadataBlock = match[1];
  const lines = metadataBlock.split('\n');

  const data: Record<string, string> = {};
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();
    if (key && value) {
      data[key] = value;
    }
  }

  // Validate required fields
  if (!data.version || !data.from || !data.type) {
    return null;
  }

  // Validate type
  const validTypes = ['major', 'minor', 'patch', 'transition'];
  if (!validTypes.includes(data.type)) {
    return null;
  }

  return {
    version: data.version,
    from: data.from,
    type: data.type as ReleaseMetadata['type'],
  };
}

/**
 * Check if a commit message is a release commit (with or without metadata).
 * Returns the version if found, null otherwise.
 *
 * Prefers structured metadata, falls back to title parsing for backwards compatibility.
 */
export function extractVersionFromCommit(commitMessage: string): string | null {
  // First, try to parse structured metadata
  const metadata = parseReleaseMetadata(commitMessage);
  if (metadata) {
    return metadata.version;
  }

  // Fall back to parsing the commit title for backwards compatibility
  // Match "chore: release v1.2.3" or "chore: release v1.2.3-beta.1"
  const titleMatch = commitMessage.match(/^chore: release v(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
  if (titleMatch) {
    return titleMatch[1];
  }

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
