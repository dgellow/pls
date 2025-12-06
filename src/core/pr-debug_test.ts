import { assertEquals } from '@std/assert';
import {
  appendDebugEntry,
  generateDebugBlock,
  generateDebugEntry,
  parseDebugBlock,
} from './pr-debug.ts';

Deno.test('generateDebugEntry - creates entry with timestamp', () => {
  const entry = generateDebugEntry('pls prep', { 'Base version': '1.0.0' });

  assertEquals(entry.command, 'pls prep');
  assertEquals(entry.details['Base version'], '1.0.0');
  assertEquals(entry.timestamp instanceof Date, true);
});

Deno.test('generateDebugBlock - creates markdown block', () => {
  const entry = generateDebugEntry('pls prep', {
    'Base version': '1.0.0',
    'Commits analyzed': '5',
  });

  const block = generateDebugBlock([entry]);

  assertEquals(block.includes('<details>'), true);
  assertEquals(block.includes('<summary>Debug Log</summary>'), true);
  assertEquals(block.includes('<!-- pls:debug -->'), true);
  assertEquals(block.includes('<!-- pls:debug:end -->'), true);
  assertEquals(block.includes('`pls prep`'), true);
  assertEquals(block.includes('**Base version**: 1.0.0'), true);
  assertEquals(block.includes('**Commits analyzed**: 5'), true);
});

Deno.test('generateDebugBlock - returns empty for no entries', () => {
  const block = generateDebugBlock([]);
  assertEquals(block, '');
});

Deno.test('parseDebugBlock - extracts entries from body', () => {
  const body = `## Release 1.0.0

Some content

<details>
<summary>Debug Log</summary>

<!-- pls:debug -->
### 2024-01-15 14:30:22 UTC — \`pls prep\`
- **Base version**: 1.0.0
- **Commits analyzed**: 5
<!-- pls:debug:end -->

</details>`;

  const entries = parseDebugBlock(body);

  assertEquals(entries.length, 1);
  assertEquals(entries[0].command, 'pls prep');
  assertEquals(entries[0].details['Base version'], '1.0.0');
  assertEquals(entries[0].details['Commits analyzed'], '5');
});

Deno.test('parseDebugBlock - returns empty for no debug block', () => {
  const body = '## Release 1.0.0\n\nNo debug block here';
  const entries = parseDebugBlock(body);
  assertEquals(entries.length, 0);
});

Deno.test('parseDebugBlock - handles multiple entries', () => {
  const body = `<details>
<summary>Debug Log</summary>

<!-- pls:debug -->
### 2024-01-15 14:30:22 UTC — \`pls prep\`
- **Base version**: 1.0.0

### 2024-01-15 14:35:00 UTC — \`pls prep --github-pr=10\`
- **Base version**: 1.0.0
- **Selection changed**: 1.0.0 → 1.0.0-alpha.0
<!-- pls:debug:end -->

</details>`;

  const entries = parseDebugBlock(body);

  assertEquals(entries.length, 2);
  assertEquals(entries[0].command, 'pls prep');
  assertEquals(entries[1].command, 'pls prep --github-pr=10');
  assertEquals(entries[1].details['Selection changed'], '1.0.0 → 1.0.0-alpha.0');
});

Deno.test('appendDebugEntry - adds new entry to body', () => {
  const body = '## Release 1.0.0\n\nSome content';
  const entry = generateDebugEntry('pls prep', { 'Base version': '1.0.0' });

  const updated = appendDebugEntry(body, entry);

  assertEquals(updated.includes('<details>'), true);
  assertEquals(updated.includes('`pls prep`'), true);
  assertEquals(updated.includes('**Base version**: 1.0.0'), true);
});

Deno.test('appendDebugEntry - preserves existing entries', () => {
  const body = `## Release 1.0.0

<details>
<summary>Debug Log</summary>

<!-- pls:debug -->
### 2024-01-15 14:30:22 UTC — \`pls prep\`
- **Base version**: 1.0.0
<!-- pls:debug:end -->

</details>`;

  const entry = generateDebugEntry('pls prep --github-pr=10', {
    'Selection changed': '1.0.0 → 1.0.0-alpha.0',
  });

  const updated = appendDebugEntry(body, entry);
  const entries = parseDebugBlock(updated);

  assertEquals(entries.length, 2);
  assertEquals(entries[0].command, 'pls prep');
  assertEquals(entries[1].command, 'pls prep --github-pr=10');
});

Deno.test('appendDebugEntry - limits to 10 entries', () => {
  // Create body with 10 existing entries
  const entries = [];
  for (let i = 0; i < 10; i++) {
    entries.push({
      timestamp: new Date(`2024-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`),
      command: `pls prep #${i + 1}`,
      details: { count: String(i + 1) },
    });
  }

  let body = '## Release 1.0.0\n\n' + generateDebugBlock(entries);

  // Add 11th entry
  const newEntry = generateDebugEntry('pls prep #11', { count: '11' });
  body = appendDebugEntry(body, newEntry);

  const parsed = parseDebugBlock(body);

  // Should have 10 entries (oldest one dropped)
  assertEquals(parsed.length, 10);
  assertEquals(parsed[0].command, 'pls prep #2'); // #1 was dropped
  assertEquals(parsed[9].command, 'pls prep #11');
});
