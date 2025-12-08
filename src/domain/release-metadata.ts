/**
 * Release metadata - parse and generate ---pls-release--- format.
 *
 * Used in both commit messages and tag messages for consistency.
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
 */

import type { ReleaseMetadata } from './types.ts';

const DELIMITER = '---pls-release---';

/**
 * Check if a message contains pls release metadata.
 */
export function hasReleaseMetadata(message: string): boolean {
  return message.includes(DELIMITER);
}

/**
 * Parse release metadata from commit or tag message.
 */
export function parseReleaseMetadata(message: string): ReleaseMetadata | null {
  const startIndex = message.indexOf(DELIMITER);
  if (startIndex === -1) return null;

  const afterStart = message.slice(startIndex + DELIMITER.length);
  const endIndex = afterStart.indexOf(DELIMITER);
  if (endIndex === -1) return null;

  const metadataSection = afterStart.slice(0, endIndex).trim();

  const metadata: Record<string, string> = {};
  for (const line of metadataSection.split('\n')) {
    const [key, ...valueParts] = line.split(':');
    if (key && valueParts.length > 0) {
      metadata[key.trim()] = valueParts.join(':').trim();
    }
  }

  if (!metadata.version || !metadata.from || !metadata.type) {
    return null;
  }

  const type = metadata.type as ReleaseMetadata['type'];
  if (!['major', 'minor', 'patch', 'transition'].includes(type)) {
    return null;
  }

  return {
    version: metadata.version,
    from: metadata.from,
    type,
  };
}

/**
 * Generate release metadata block.
 */
export function generateReleaseMetadata(metadata: ReleaseMetadata): string {
  return `${DELIMITER}
version: ${metadata.version}
from: ${metadata.from}
type: ${metadata.type}
${DELIMITER}`;
}

/**
 * Generate complete release commit message.
 */
export function generateReleaseCommitMessage(metadata: ReleaseMetadata): string {
  return `chore: release v${metadata.version}

${generateReleaseMetadata(metadata)}`;
}

/**
 * Generate complete release tag message.
 */
export function generateReleaseTagMessage(
  metadata: ReleaseMetadata,
  changelog: string,
): string {
  return `Release v${metadata.version}

${changelog}

${generateReleaseMetadata(metadata)}`;
}
