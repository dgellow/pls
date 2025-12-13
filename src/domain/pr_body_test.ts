/**
 * Tests for PR body generation and parsing.
 */

import { assertEquals } from '@std/assert';
import {
  generateBootstrapPRBody,
  generateOptions,
  generateOptionsBlock,
  generatePRBody,
  getSelectedVersion,
  parseOptionsBlock,
  updatePRBody,
} from './pr-body.ts';
import type { Commit, VersionBump, VersionOption } from './types.ts';

const makeCommit = (type: string, description: string): Commit => ({
  sha: 'abc123',
  type,
  scope: null,
  description,
  breaking: false,
  body: null,
});

const makeBump = (from: string, to: string, type: 'major' | 'minor' | 'patch'): VersionBump => ({
  from,
  to,
  type,
  commits: [makeCommit('feat', 'test feature')],
});

Deno.test('generateOptions', async (t) => {
  await t.step('generates options for minor bump from stable', () => {
    const bump = makeBump('1.0.0', '1.1.0', 'minor');
    const options = generateOptions(bump);

    // First option is the calculated bump (selected)
    assertEquals(options[0].version, '1.1.0');
    assertEquals(options[0].type, 'minor');
    assertEquals(options[0].selected, true);
    assertEquals(options[0].disabled, false);

    // Should include prerelease options (alpha, beta, rc) for stable versions
    const hasAlpha = options.some((o) => o.label === 'alpha');
    const hasBeta = options.some((o) => o.label === 'beta');
    const hasRc = options.some((o) => o.label === 'rc');
    assertEquals(hasAlpha, true);
    assertEquals(hasBeta, true);
    assertEquals(hasRc, true);
  });

  await t.step('generates options for major bump', () => {
    const bump = makeBump('1.2.3', '2.0.0', 'major');
    const options = generateOptions(bump);

    assertEquals(options[0].version, '2.0.0');
    assertEquals(options[0].type, 'major');
    assertEquals(options[0].selected, true);
  });

  await t.step('generates options for patch bump', () => {
    const bump = makeBump('1.2.3', '1.2.4', 'patch');
    const options = generateOptions(bump);

    assertEquals(options[0].version, '1.2.4');
    assertEquals(options[0].type, 'patch');
    assertEquals(options[0].selected, true);
  });

  await t.step('generates progression options for alpha version', () => {
    const bump = makeBump('1.0.0-alpha.0', '1.0.0-alpha.1', 'patch');
    const options = generateOptions(bump);

    // Should have progression options: beta, rc, stable
    const hasBeta = options.some((o) => o.label === 'beta');
    const hasRc = options.some((o) => o.label === 'rc');
    const hasStable = options.some((o) => o.label === 'stable');
    assertEquals(hasBeta, true);
    assertEquals(hasRc, true);
    assertEquals(hasStable, true);

    // Alpha should not be an option (already there)
    const alphaOption = options.find((o) => o.label === 'alpha');
    assertEquals(alphaOption?.disabled ?? true, true);
  });

  await t.step('generates progression options for beta version', () => {
    const bump = makeBump('1.0.0-beta.0', '1.0.0-beta.1', 'patch');
    const options = generateOptions(bump);

    // Should have rc and stable enabled
    const hasRc = options.some((o) => o.label === 'rc' && !o.disabled);
    const hasStable = options.some((o) => o.label === 'stable' && !o.disabled);
    assertEquals(hasRc, true);
    assertEquals(hasStable, true);

    // Alpha should be disabled (past stage)
    const alphaOption = options.find((o) => o.label === 'alpha');
    assertEquals(alphaOption?.disabled, true);
  });
});

Deno.test('generateOptionsBlock', async (t) => {
  await t.step('generates block with selected option as current', () => {
    const options: VersionOption[] = [
      { version: '1.1.0', type: 'minor', label: 'minor', selected: true, disabled: false },
      {
        version: '1.1.0-alpha.0',
        type: 'transition',
        label: 'alpha',
        selected: false,
        disabled: false,
      },
      {
        version: '1.1.0-beta.0',
        type: 'transition',
        label: 'beta',
        selected: false,
        disabled: false,
      },
    ];
    const block = generateOptionsBlock(options);

    assertEquals(block.includes('<!-- pls:options -->'), true);
    assertEquals(block.includes('<!-- pls:options:end -->'), true);
    assertEquals(block.includes('**Current: 1.1.0** (minor)'), true);
    assertEquals(block.includes('- [ ] 1.1.0-alpha.0 (alpha)'), true);
    assertEquals(block.includes('- [ ] 1.1.0-beta.0 (beta)'), true);
  });

  await t.step('shows disabled options with strikethrough', () => {
    const options: VersionOption[] = [
      { version: '1.0.0-beta.1', type: 'patch', label: 'patch', selected: true, disabled: false },
      {
        version: '1.0.0-alpha.0',
        type: 'transition',
        label: 'alpha',
        selected: false,
        disabled: true,
        disabledReason: 'already past alpha',
      },
    ];
    const block = generateOptionsBlock(options);

    assertEquals(block.includes('~~1.0.0-alpha.0~~'), true);
    assertEquals(block.includes(':disabled:'), true);
  });
});

Deno.test('parseOptionsBlock', async (t) => {
  await t.step('parses current selection', () => {
    const body = `Some text
<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [ ] 1.1.0-alpha.0 (alpha) <!-- pls:v:1.1.0-alpha.0:transition -->
<!-- pls:options:end -->
More text`;

    const result = parseOptionsBlock(body);
    assertEquals(result !== null, true);
    assertEquals(result!.selected?.version, '1.1.0');
    assertEquals(result!.options.length >= 1, true);
  });

  await t.step('detects checked alternative selection', () => {
    const body = `<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [x] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
- [ ] 1.0.1 (patch) <!-- pls:v:1.0.1:patch -->
<!-- pls:options:end -->`;

    const result = parseOptionsBlock(body);
    assertEquals(result !== null, true);
    assertEquals(result!.selected?.version, '2.0.0');
  });

  await t.step('returns null for missing block', () => {
    const body = 'No options block here';
    assertEquals(parseOptionsBlock(body), null);
  });

  await t.step('handles multiple checked boxes (takes first)', () => {
    const body = `<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [x] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
- [x] 1.0.1 (patch) <!-- pls:v:1.0.1:patch -->
<!-- pls:options:end -->`;

    const result = parseOptionsBlock(body);
    assertEquals(result!.selected?.version, '2.0.0');
  });

  await t.step('ignores disabled checked options', () => {
    const body = `<!-- pls:options -->
**Current: 1.0.0-beta.1** (patch) <!-- pls:v:1.0.0-beta.1:patch:current -->

Switch to:
- [x] ~~1.0.0-alpha.0~~ (alpha) <!-- pls:v:1.0.0-alpha.0:transition:disabled:already past alpha -->
- [ ] 1.0.0 (stable) <!-- pls:v:1.0.0:transition -->
<!-- pls:options:end -->`;

    const result = parseOptionsBlock(body);
    // Disabled option should not be selected even if checked
    assertEquals(result!.selected?.version, '1.0.0-beta.1');
  });
});

Deno.test('getSelectedVersion', async (t) => {
  await t.step('returns selected checkbox version', () => {
    const body = `<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [x] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
<!-- pls:options:end -->`;

    assertEquals(getSelectedVersion(body), '2.0.0');
  });

  await t.step('returns current version when no checkbox checked', () => {
    const body = `<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [ ] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
<!-- pls:options:end -->`;

    assertEquals(getSelectedVersion(body), '1.1.0');
  });

  await t.step('returns null for no block', () => {
    assertEquals(getSelectedVersion('No block'), null);
  });
});

Deno.test('generatePRBody', async (t) => {
  await t.step('generates full PR body', () => {
    const bump: VersionBump = {
      from: '1.0.0',
      to: '1.1.0',
      type: 'minor',
      commits: [makeCommit('feat', 'add feature')],
    };
    const changelog = '- Added feature X\n- Fixed bug Y';
    const body = generatePRBody(bump, changelog);

    assertEquals(body.includes('## Release 1.1.0'), true);
    assertEquals(body.includes('<!-- pls:options -->'), true);
    assertEquals(body.includes('**Current: 1.1.0**'), true);
    assertEquals(body.includes('### Changes'), true);
    assertEquals(body.includes('Added feature X'), true);
    assertEquals(body.includes('Version Selection'), true);
  });

  await t.step('includes all expected sections', () => {
    const bump = makeBump('2.0.0', '2.1.0', 'minor');
    const body = generatePRBody(bump, 'Some changes');

    assertEquals(body.includes('automatically created by pls'), true);
    assertEquals(body.includes('Merging this PR'), true);
    assertEquals(body.includes('<details>'), true);
  });
});

Deno.test('updatePRBody', async (t) => {
  await t.step('updates options block with new selection', () => {
    const originalBody = `## Release 1.1.0

Some intro text.

<details>
<summary>Version Selection</summary>

<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [ ] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
- [ ] 1.0.1 (patch) <!-- pls:v:1.0.1:patch -->
<!-- pls:options:end -->

</details>

### Changes
- Something`;

    const newBody = updatePRBody(originalBody, '2.0.0');

    // Should now show 2.0.0 as current
    assertEquals(newBody.includes('**Current: 2.0.0**'), true);
    // Title should be updated
    assertEquals(newBody.includes('## Release 2.0.0'), true);
  });

  await t.step('preserves content outside options block', () => {
    const originalBody = `## Release 1.1.0

Intro text here.

<!-- pls:options -->
**Current: 1.1.0** (minor) <!-- pls:v:1.1.0:minor:current -->

Switch to:
- [ ] 2.0.0 (major) <!-- pls:v:2.0.0:major -->
<!-- pls:options:end -->

### Changes
Footer text here.`;

    const newBody = updatePRBody(originalBody, '2.0.0');

    assertEquals(newBody.includes('Intro text here'), true);
    assertEquals(newBody.includes('Footer text here'), true);
    assertEquals(newBody.includes('### Changes'), true);
  });

  await t.step('returns original body if no options block', () => {
    const originalBody = 'No options block here';
    const newBody = updatePRBody(originalBody, '2.0.0');
    assertEquals(newBody, originalBody);
  });
});

Deno.test('generateBootstrapPRBody', async (t) => {
  await t.step('generates bootstrap PR body with version and manifest', () => {
    const body = generateBootstrapPRBody('1.2.3', 'deno.json');

    assertEquals(body.includes('## Initialize pls'), true);
    assertEquals(body.includes('`.pls/versions.json`'), true);
    assertEquals(body.includes('`1.2.3`'), true);
    assertEquals(body.includes('`deno.json`'), true);
    assertEquals(body.includes('Future releases will work automatically'), true);
  });

  await t.step('works with package.json manifest', () => {
    const body = generateBootstrapPRBody('2.0.0', 'package.json');

    assertEquals(body.includes('`2.0.0`'), true);
    assertEquals(body.includes('`package.json`'), true);
  });

  await t.step('does not include version selection UI', () => {
    const body = generateBootstrapPRBody('1.0.0', 'deno.json');

    assertEquals(body.includes('<!-- pls:options -->'), false);
    assertEquals(body.includes('Switch to:'), false);
  });
});
