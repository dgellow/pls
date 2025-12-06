import { assertEquals, assertExists } from '@std/assert';
import {
  generateOptions,
  generateOptionsBlock,
  getSelectedVersion,
  hasSelectionChanged,
  parseOptionsBlock,
  updateOptionsBlock,
} from './pr-options.ts';
import type { VersionBump } from '../types.ts';

Deno.test('generateOptions - creates options for stable version', () => {
  const bump: VersionBump = {
    from: '1.2.3',
    to: '1.3.0',
    type: 'minor',
    commits: [],
  };

  const options = generateOptions('1.2.3', bump);

  // Should have main option selected
  const selected = options.find((o) => o.selected);
  assertExists(selected);
  assertEquals(selected.version, '1.3.0');
  assertEquals(selected.type, 'minor');

  // Should have prerelease options
  const alpha = options.find((o) => o.version === '1.3.0-alpha.0');
  assertExists(alpha);
  assertEquals(alpha.type, 'transition');
  assertEquals(alpha.disabled, false);
});

Deno.test('generateOptions - from prerelease only offers forward progression', () => {
  const bump: VersionBump = {
    from: '1.3.0-beta.2',
    to: '1.3.0-beta.3',
    type: 'patch',
    commits: [],
  };

  const options = generateOptions('1.3.0-beta.2', bump);

  // Should not offer alpha (past that stage)
  const alpha = options.find((o) => o.version.includes('alpha'));
  if (alpha) {
    assertEquals(alpha.disabled, true);
  }

  // Should offer rc and stable
  const rc = options.find((o) => o.version === '1.3.0-rc.0');
  assertExists(rc);
  assertEquals(rc.disabled, false);

  const stable = options.find((o) => o.version === '1.3.0');
  assertExists(stable);
  assertEquals(stable.disabled, false);
});

Deno.test('generateOptionsBlock - creates valid markdown', () => {
  const bump: VersionBump = {
    from: '1.2.3',
    to: '1.3.0',
    type: 'minor',
    commits: [],
  };

  const options = generateOptions('1.2.3', bump);
  const block = generateOptionsBlock(options);

  // Should contain markers
  assertEquals(block.includes('<!-- pls:options -->'), true);
  assertEquals(block.includes('<!-- pls:options:end -->'), true);

  // Current selection should NOT have checkbox, marked with :current
  assertEquals(block.includes('**Current: 1.3.0**'), true);
  assertEquals(block.includes('<!-- pls:v:1.3.0:minor:current -->'), true);

  // Alternatives should have unchecked checkboxes
  assertEquals(block.includes('[ ]'), true);
  assertEquals(block.includes('Switch to:'), true);
});

Deno.test('parseOptionsBlock - extracts selected version', () => {
  const body = `## Release 1.3.0

<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
- [ ] 1.3.0-beta.0 (beta) <!-- pls:v:1.3.0-beta.0:transition -->
<!-- pls:options:end -->

Some other content`;

  const parsed = parseOptionsBlock(body);
  assertExists(parsed);
  assertEquals(parsed.options.length, 3);
  assertEquals(parsed.selected?.version, '1.3.0');
  assertEquals(parsed.selected?.type, 'minor');
});

Deno.test('parseOptionsBlock - returns null for missing block', () => {
  const body = `## Release 1.3.0

No options block here.`;

  const parsed = parseOptionsBlock(body);
  assertEquals(parsed, null);
});

Deno.test('getSelectedVersion - extracts version from body', () => {
  // User checked an alternative, so that becomes selected
  const body = `<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [x] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
<!-- pls:options:end -->`;

  const selected = getSelectedVersion(body);
  assertEquals(selected, '1.3.0-alpha.0');
});

Deno.test('updateOptionsBlock - changes selection', () => {
  const body = `## Release

<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
<!-- pls:options:end -->

Footer`;

  const updated = updateOptionsBlock(body, '1.3.0-alpha.0');

  // New current selection should be displayed without checkbox
  assertEquals(updated.includes('**Current: 1.3.0-alpha.0**'), true);
  assertEquals(updated.includes('<!-- pls:v:1.3.0-alpha.0:transition:current -->'), true);

  // Old selection should now be an alternative
  assertEquals(updated.includes('- [ ] 1.3.0 (minor)'), true);

  // Should preserve surrounding content
  assertEquals(updated.includes('## Release'), true);
  assertEquals(updated.includes('Footer'), true);
});

Deno.test('hasSelectionChanged - detects changes', () => {
  const oldBody = `<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [ ] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
<!-- pls:options:end -->`;

  // User checked alpha alternative
  const newBody = `<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [x] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
<!-- pls:options:end -->`;

  assertEquals(hasSelectionChanged(oldBody, newBody), true);
  assertEquals(hasSelectionChanged(oldBody, oldBody), false);
});

Deno.test('parseOptionsBlock - handles disabled options', () => {
  const body = `<!-- pls:options -->
**Current: 1.3.0-beta.0** (beta) <!-- pls:v:1.3.0-beta.0:transition:current -->

Switch to:
- [ ] ~~1.3.0-alpha.0~~ (alpha) <!-- pls:v:1.3.0-alpha.0:transition:disabled:already past alpha -->
<!-- pls:options:end -->`;

  const parsed = parseOptionsBlock(body);
  assertExists(parsed);

  const alpha = parsed.options.find((o) => o.version === '1.3.0-alpha.0');
  assertExists(alpha);
  assertEquals(alpha.disabled, true);
  assertEquals(alpha.disabledReason, 'already past alpha');
});

Deno.test('parseOptionsBlock - picks first checked alternative', () => {
  // User checked multiple alternatives - should pick the first one
  const body = `<!-- pls:options -->
**Current: 1.3.0** (minor) <!-- pls:v:1.3.0:minor:current -->

Switch to:
- [x] 1.3.0-alpha.0 (alpha) <!-- pls:v:1.3.0-alpha.0:transition -->
- [x] 1.3.0-beta.0 (beta) <!-- pls:v:1.3.0-beta.0:transition -->
<!-- pls:options:end -->`;

  const parsed = parseOptionsBlock(body);
  assertExists(parsed);

  // Should pick the first checked alternative (alpha), not current
  assertEquals(parsed.selected?.version, '1.3.0-alpha.0');
});

Deno.test('parseOptionsBlock - returns null for empty body', () => {
  const parsed = parseOptionsBlock('');
  assertEquals(parsed, null);
});

Deno.test('parseOptionsBlock - handles malformed options block', () => {
  // Missing end marker
  const body1 = `<!-- pls:options -->
- [x] **1.3.0** (minor) <!-- pls:v:1.3.0:minor -->`;
  assertEquals(parseOptionsBlock(body1), null);

  // Missing start marker
  const body2 = `- [x] **1.3.0** (minor) <!-- pls:v:1.3.0:minor -->
<!-- pls:options:end -->`;
  assertEquals(parseOptionsBlock(body2), null);

  // End before start
  const body3 = `<!-- pls:options:end -->
- [x] **1.3.0** (minor) <!-- pls:v:1.3.0:minor -->
<!-- pls:options -->`;
  assertEquals(parseOptionsBlock(body3), null);
});

Deno.test('parseOptionsBlock - handles options block with no valid options', () => {
  const body = `<!-- pls:options -->
Some random text without proper markers
<!-- pls:options:end -->`;

  const parsed = parseOptionsBlock(body);
  assertExists(parsed);
  assertEquals(parsed.options.length, 0);
  assertEquals(parsed.selected, null);
});

Deno.test('getSelectedVersion - returns null for empty body', () => {
  assertEquals(getSelectedVersion(''), null);
});
