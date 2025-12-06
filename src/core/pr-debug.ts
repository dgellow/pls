/**
 * Debug log functionality for PR bodies.
 * Appends diagnostic information to help understand what pls did.
 */

export interface DebugEntry {
  timestamp: Date;
  command: string;
  details: Record<string, string>;
}

const DEBUG_START_MARKER = '<!-- pls:debug -->';
const DEBUG_END_MARKER = '<!-- pls:debug:end -->';

/**
 * Generate a debug entry for a prep/sync operation.
 */
export function generateDebugEntry(
  command: string,
  details: Record<string, string>,
): DebugEntry {
  return {
    timestamp: new Date(),
    command,
    details,
  };
}

/**
 * Format a debug entry as markdown.
 */
function formatDebugEntry(entry: DebugEntry): string {
  const timestamp = entry.timestamp.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const lines = [`### ${timestamp} — \`${entry.command}\``];

  for (const [key, value] of Object.entries(entry.details)) {
    lines.push(`- **${key}**: ${value}`);
  }

  return lines.join('\n');
}

/**
 * Generate the full debug block for the PR body.
 */
export function generateDebugBlock(entries: DebugEntry[]): string {
  if (entries.length === 0) return '';

  const formattedEntries = entries.map(formatDebugEntry).join('\n\n');

  return `
<details>
<summary>Debug Log</summary>

${DEBUG_START_MARKER}
${formattedEntries}
${DEBUG_END_MARKER}

</details>`;
}

/**
 * Parse existing debug entries from a PR body.
 */
export function parseDebugBlock(body: string): DebugEntry[] {
  const startIndex = body.indexOf(DEBUG_START_MARKER);
  const endIndex = body.indexOf(DEBUG_END_MARKER);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return [];
  }

  const content = body.substring(startIndex + DEBUG_START_MARKER.length, endIndex).trim();
  if (!content) return [];

  const entries: DebugEntry[] = [];
  const entryBlocks = content.split(/\n### /).filter(Boolean);

  for (const block of entryBlocks) {
    const blockContent = block.startsWith('### ') ? block : `### ${block}`;
    const lines = blockContent.split('\n');

    // Parse header: ### 2024-01-15 14:30:22 UTC — `pls prep`
    const headerMatch = lines[0].match(/^### (.+?) — `(.+)`$/);
    if (!headerMatch) continue;

    const [, timestampStr, command] = headerMatch;
    const timestamp = new Date(timestampStr.replace(' UTC', 'Z').replace(' ', 'T'));

    // Parse details
    const details: Record<string, string> = {};
    for (let i = 1; i < lines.length; i++) {
      const detailMatch = lines[i].match(/^- \*\*(.+?)\*\*: (.+)$/);
      if (detailMatch) {
        details[detailMatch[1]] = detailMatch[2];
      }
    }

    entries.push({ timestamp, command, details });
  }

  return entries;
}

/**
 * Update a PR body with a new debug entry, preserving existing entries.
 * Keeps only the last 10 entries to avoid bloat.
 */
export function appendDebugEntry(body: string, entry: DebugEntry): string {
  const existingEntries = parseDebugBlock(body);
  const allEntries = [...existingEntries, entry].slice(-10); // Keep last 10

  // Remove existing debug block if present
  let cleanBody = body;
  const detailsStart = body.indexOf('<details>\n<summary>Debug Log</summary>');
  if (detailsStart !== -1) {
    const detailsEnd = body.indexOf('</details>', detailsStart);
    if (detailsEnd !== -1) {
      cleanBody = body.substring(0, detailsStart).trimEnd() +
        body.substring(detailsEnd + '</details>'.length);
    }
  }

  // Append new debug block
  return cleanBody.trimEnd() + '\n' + generateDebugBlock(allEntries);
}
