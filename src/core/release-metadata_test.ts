import { assertEquals, assertNotEquals } from '@std/assert';
import {
  extractVersionFromCommit,
  generateReleaseCommitMessage,
  parseReleaseMetadata,
} from './release-metadata.ts';

Deno.test('generateReleaseCommitMessage - creates structured message', () => {
  const message = generateReleaseCommitMessage({
    version: '1.2.3',
    from: '1.2.2',
    type: 'patch',
  });

  // Check title
  assertEquals(message.startsWith('chore: release v1.2.3'), true);

  // Check metadata block exists
  assertEquals(message.includes('---pls-release---'), true);
  assertEquals(message.includes('version: 1.2.3'), true);
  assertEquals(message.includes('from: 1.2.2'), true);
  assertEquals(message.includes('type: patch'), true);
});

Deno.test('parseReleaseMetadata - parses valid metadata', () => {
  const message = `chore: release v1.2.3

---pls-release---
version: 1.2.3
from: 1.2.2
type: minor
---pls-release---`;

  const metadata = parseReleaseMetadata(message);

  assertNotEquals(metadata, null);
  assertEquals(metadata?.version, '1.2.3');
  assertEquals(metadata?.from, '1.2.2');
  assertEquals(metadata?.type, 'minor');
});

Deno.test('parseReleaseMetadata - returns null for missing metadata', () => {
  const message = 'chore: release v1.2.3';
  const metadata = parseReleaseMetadata(message);
  assertEquals(metadata, null);
});

Deno.test('parseReleaseMetadata - returns null for incomplete metadata', () => {
  const message = `chore: release v1.2.3

---pls-release---
version: 1.2.3
---pls-release---`;

  const metadata = parseReleaseMetadata(message);
  assertEquals(metadata, null);
});

Deno.test('parseReleaseMetadata - returns null for invalid type', () => {
  const message = `chore: release v1.2.3

---pls-release---
version: 1.2.3
from: 1.2.2
type: invalid
---pls-release---`;

  const metadata = parseReleaseMetadata(message);
  assertEquals(metadata, null);
});

Deno.test('extractVersionFromCommit - extracts from structured metadata', () => {
  const message = `chore: release v1.2.3

---pls-release---
version: 1.2.3
from: 1.2.2
type: minor
---pls-release---`;

  const version = extractVersionFromCommit(message);
  assertEquals(version, '1.2.3');
});

Deno.test('extractVersionFromCommit - falls back to title parsing', () => {
  const message = 'chore: release v1.2.3';
  const version = extractVersionFromCommit(message);
  assertEquals(version, '1.2.3');
});

Deno.test('extractVersionFromCommit - handles prerelease versions', () => {
  const message = 'chore: release v1.2.3-beta.1';
  const version = extractVersionFromCommit(message);
  assertEquals(version, '1.2.3-beta.1');
});

Deno.test('extractVersionFromCommit - returns null for non-release commits', () => {
  const message = 'feat: add new feature';
  const version = extractVersionFromCommit(message);
  assertEquals(version, null);
});

Deno.test('roundtrip - generate and parse metadata', () => {
  const original = {
    version: '2.0.0',
    from: '1.5.0',
    type: 'major' as const,
  };

  const message = generateReleaseCommitMessage(original);
  const parsed = parseReleaseMetadata(message);

  assertNotEquals(parsed, null);
  assertEquals(parsed?.version, original.version);
  assertEquals(parsed?.from, original.from);
  assertEquals(parsed?.type, original.type);
});

Deno.test('roundtrip - generate and extract version', () => {
  const message = generateReleaseCommitMessage({
    version: '3.0.0-alpha.1',
    from: '2.0.0',
    type: 'transition',
  });

  const version = extractVersionFromCommit(message);
  assertEquals(version, '3.0.0-alpha.1');
});
