/**
 * Tests for release metadata parsing and generation.
 */

import { assertEquals } from '@std/assert';
import {
  generateReleaseCommitMessage,
  generateReleaseMetadata,
  generateReleaseTagMessage,
  hasReleaseMetadata,
  parseReleaseMetadata,
} from './release-metadata.ts';

Deno.test('hasReleaseMetadata', async (t) => {
  await t.step('returns true for message with metadata', () => {
    const message = `chore: release v1.0.0

---pls-release---
version: 1.0.0
from: 0.9.0
type: minor
---pls-release---`;
    assertEquals(hasReleaseMetadata(message), true);
  });

  await t.step('returns false for message without metadata', () => {
    assertEquals(hasReleaseMetadata('chore: release v1.0.0'), false);
    assertEquals(hasReleaseMetadata('feat: add feature'), false);
    assertEquals(hasReleaseMetadata(''), false);
  });

  await t.step('returns true for partial delimiter', () => {
    // Even one delimiter counts
    assertEquals(hasReleaseMetadata('---pls-release---'), true);
  });
});

Deno.test('parseReleaseMetadata', async (t) => {
  await t.step('parses valid metadata', () => {
    const message = `chore: release v1.2.3

---pls-release---
version: 1.2.3
from: 1.2.2
type: patch
---pls-release---`;
    const result = parseReleaseMetadata(message);

    assertEquals(result?.version, '1.2.3');
    assertEquals(result?.from, '1.2.2');
    assertEquals(result?.type, 'patch');
  });

  await t.step('parses all bump types', () => {
    const types = ['major', 'minor', 'patch', 'transition'] as const;

    for (const type of types) {
      const message = `chore: release

---pls-release---
version: 1.0.0
from: 0.9.0
type: ${type}
---pls-release---`;
      const result = parseReleaseMetadata(message);
      assertEquals(result?.type, type);
    }
  });

  await t.step('returns null for missing delimiter', () => {
    assertEquals(parseReleaseMetadata('chore: release v1.0.0'), null);
  });

  await t.step('returns null for missing fields', () => {
    const missingVersion = `---pls-release---
from: 1.0.0
type: patch
---pls-release---`;
    assertEquals(parseReleaseMetadata(missingVersion), null);

    const missingFrom = `---pls-release---
version: 1.0.0
type: patch
---pls-release---`;
    assertEquals(parseReleaseMetadata(missingFrom), null);

    const missingType = `---pls-release---
version: 1.0.0
from: 0.9.0
---pls-release---`;
    assertEquals(parseReleaseMetadata(missingType), null);
  });

  await t.step('returns null for invalid type', () => {
    const message = `---pls-release---
version: 1.0.0
from: 0.9.0
type: invalid
---pls-release---`;
    assertEquals(parseReleaseMetadata(message), null);
  });

  await t.step('returns null for unclosed delimiter', () => {
    const message = `---pls-release---
version: 1.0.0
from: 0.9.0
type: patch`;
    assertEquals(parseReleaseMetadata(message), null);
  });
});

Deno.test('generateReleaseMetadata', async (t) => {
  await t.step('generates correct format', () => {
    const result = generateReleaseMetadata({
      version: '1.2.3',
      from: '1.2.2',
      type: 'patch',
    });

    assertEquals(result.includes('---pls-release---'), true);
    assertEquals(result.includes('version: 1.2.3'), true);
    assertEquals(result.includes('from: 1.2.2'), true);
    assertEquals(result.includes('type: patch'), true);
  });

  await t.step('can be parsed back', () => {
    const metadata = {
      version: '2.0.0',
      from: '1.5.0',
      type: 'major' as const,
    };
    const generated = generateReleaseMetadata(metadata);
    const parsed = parseReleaseMetadata(generated);

    assertEquals(parsed?.version, metadata.version);
    assertEquals(parsed?.from, metadata.from);
    assertEquals(parsed?.type, metadata.type);
  });
});

Deno.test('generateReleaseCommitMessage', async (t) => {
  await t.step('generates commit message with metadata', () => {
    const result = generateReleaseCommitMessage({
      version: '1.0.0',
      from: '0.9.0',
      type: 'minor',
    });

    assertEquals(result.startsWith('chore: release v1.0.0'), true);
    assertEquals(result.includes('---pls-release---'), true);
    assertEquals(result.includes('version: 1.0.0'), true);
  });

  await t.step('commit message can be parsed', () => {
    const message = generateReleaseCommitMessage({
      version: '1.0.0',
      from: '0.9.0',
      type: 'minor',
    });
    const parsed = parseReleaseMetadata(message);

    assertEquals(parsed?.version, '1.0.0');
    assertEquals(parsed?.from, '0.9.0');
    assertEquals(parsed?.type, 'minor');
  });
});

Deno.test('generateReleaseTagMessage', async (t) => {
  await t.step('generates tag message with changelog', () => {
    const result = generateReleaseTagMessage(
      { version: '1.0.0', from: '0.9.0', type: 'minor' },
      '## Changes\n- Added feature X',
    );

    assertEquals(result.startsWith('Release v1.0.0'), true);
    assertEquals(result.includes('## Changes'), true);
    assertEquals(result.includes('Added feature X'), true);
    assertEquals(result.includes('---pls-release---'), true);
  });

  await t.step('tag message can be parsed', () => {
    const message = generateReleaseTagMessage(
      { version: '1.0.0', from: '0.9.0', type: 'minor' },
      'Changelog here',
    );
    const parsed = parseReleaseMetadata(message);

    assertEquals(parsed?.version, '1.0.0');
    assertEquals(parsed?.from, '0.9.0');
    assertEquals(parsed?.type, 'minor');
  });
});
