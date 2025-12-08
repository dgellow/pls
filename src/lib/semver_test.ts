/**
 * Tests for semver utilities.
 */

import { assertEquals, assertThrows } from '@std/assert';
import {
  bump,
  bumpPrerelease,
  compare,
  format,
  getBase,
  getStage,
  parse,
  toPrerelease,
  transition,
} from './semver.ts';

Deno.test('parse', async (t) => {
  await t.step('parses stable version', () => {
    const result = parse('1.2.3');
    assertEquals(result, {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: null,
    });
  });

  await t.step('parses prerelease version', () => {
    const result = parse('1.2.3-alpha.0');
    assertEquals(result, {
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'alpha.0',
    });
  });

  await t.step('parses beta version', () => {
    const result = parse('2.0.0-beta.5');
    assertEquals(result, {
      major: 2,
      minor: 0,
      patch: 0,
      prerelease: 'beta.5',
    });
  });

  await t.step('parses rc version', () => {
    const result = parse('1.0.0-rc.1');
    assertEquals(result, {
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'rc.1',
    });
  });

  await t.step('returns null for invalid version', () => {
    assertEquals(parse('invalid'), null);
    assertEquals(parse('1.2'), null);
    assertEquals(parse('1.2.3.4'), null);
    assertEquals(parse('v1.2.3'), null);
    assertEquals(parse(''), null);
  });
});

Deno.test('format', async (t) => {
  await t.step('formats stable version', () => {
    assertEquals(
      format({ major: 1, minor: 2, patch: 3, prerelease: null }),
      '1.2.3',
    );
  });

  await t.step('formats prerelease version', () => {
    assertEquals(
      format({ major: 1, minor: 2, patch: 3, prerelease: 'alpha.0' }),
      '1.2.3-alpha.0',
    );
  });
});

Deno.test('getStage', async (t) => {
  await t.step('returns stable for stable versions', () => {
    assertEquals(getStage('1.2.3'), 'stable');
    assertEquals(getStage('0.0.1'), 'stable');
  });

  await t.step('returns alpha for alpha versions', () => {
    assertEquals(getStage('1.0.0-alpha.0'), 'alpha');
    assertEquals(getStage('2.0.0-alpha.5'), 'alpha');
  });

  await t.step('returns beta for beta versions', () => {
    assertEquals(getStage('1.0.0-beta.0'), 'beta');
  });

  await t.step('returns rc for rc versions', () => {
    assertEquals(getStage('1.0.0-rc.0'), 'rc');
    assertEquals(getStage('1.0.0-rc.3'), 'rc');
  });
});

Deno.test('getBase', async (t) => {
  await t.step('returns base for stable version', () => {
    assertEquals(getBase('1.2.3'), '1.2.3');
  });

  await t.step('strips prerelease suffix', () => {
    assertEquals(getBase('1.2.3-alpha.0'), '1.2.3');
    assertEquals(getBase('2.0.0-beta.5'), '2.0.0');
    assertEquals(getBase('1.0.0-rc.1'), '1.0.0');
  });
});

Deno.test('bump', async (t) => {
  await t.step('bumps major version', () => {
    assertEquals(bump('1.2.3', 'major'), '2.0.0');
    assertEquals(bump('0.5.9', 'major'), '1.0.0');
  });

  await t.step('bumps minor version', () => {
    assertEquals(bump('1.2.3', 'minor'), '1.3.0');
    assertEquals(bump('1.9.5', 'minor'), '1.10.0');
  });

  await t.step('bumps patch version', () => {
    assertEquals(bump('1.2.3', 'patch'), '1.2.4');
    assertEquals(bump('1.2.9', 'patch'), '1.2.10');
  });

  await t.step('strips prerelease when bumping', () => {
    assertEquals(bump('1.2.3-alpha.0', 'major'), '2.0.0');
    assertEquals(bump('1.2.3-beta.5', 'minor'), '1.3.0');
    assertEquals(bump('1.2.3-rc.1', 'patch'), '1.2.4');
  });

  await t.step('throws for invalid version', () => {
    assertThrows(() => bump('invalid', 'major'));
  });
});

Deno.test('bumpPrerelease', async (t) => {
  await t.step('increments build number', () => {
    assertEquals(bumpPrerelease('1.0.0-alpha.0'), '1.0.0-alpha.1');
    assertEquals(bumpPrerelease('1.0.0-alpha.5'), '1.0.0-alpha.6');
    assertEquals(bumpPrerelease('1.0.0-beta.9'), '1.0.0-beta.10');
    assertEquals(bumpPrerelease('1.0.0-rc.0'), '1.0.0-rc.1');
  });

  await t.step('throws for stable version', () => {
    assertThrows(() => bumpPrerelease('1.0.0'));
  });

  await t.step('throws for invalid version', () => {
    assertThrows(() => bumpPrerelease('invalid'));
  });
});

Deno.test('toPrerelease', async (t) => {
  await t.step('creates alpha from stable with minor bump', () => {
    assertEquals(toPrerelease('1.2.3', 'minor', 'alpha'), '1.3.0-alpha.0');
  });

  await t.step('creates alpha from stable with major bump', () => {
    assertEquals(toPrerelease('1.2.3', 'major', 'alpha'), '2.0.0-alpha.0');
  });

  await t.step('creates alpha from stable with patch bump', () => {
    assertEquals(toPrerelease('1.2.3', 'patch', 'alpha'), '1.2.4-alpha.0');
  });

  await t.step('creates beta from stable', () => {
    assertEquals(toPrerelease('1.2.3', 'minor', 'beta'), '1.3.0-beta.0');
  });

  await t.step('creates rc from stable', () => {
    assertEquals(toPrerelease('1.2.3', 'minor', 'rc'), '1.3.0-rc.0');
  });
});

Deno.test('transition', async (t) => {
  await t.step('transitions stable to alpha', () => {
    assertEquals(transition('1.2.3', 'alpha'), '1.2.3-alpha.0');
  });

  await t.step('transitions alpha to beta', () => {
    assertEquals(transition('1.3.0-alpha.5', 'beta'), '1.3.0-beta.0');
  });

  await t.step('transitions beta to rc', () => {
    assertEquals(transition('1.3.0-beta.3', 'rc'), '1.3.0-rc.0');
  });

  await t.step('transitions rc to stable', () => {
    assertEquals(transition('1.3.0-rc.2', 'stable'), '1.3.0');
  });

  await t.step('transitions alpha to stable', () => {
    assertEquals(transition('1.3.0-alpha.5', 'stable'), '1.3.0');
  });

  await t.step('throws for invalid version', () => {
    assertThrows(() => transition('invalid', 'beta'));
  });
});

Deno.test('compare', async (t) => {
  await t.step('compares major versions', () => {
    assertEquals(compare('2.0.0', '1.0.0') > 0, true);
    assertEquals(compare('1.0.0', '2.0.0') < 0, true);
    assertEquals(compare('1.0.0', '1.0.0'), 0);
  });

  await t.step('compares minor versions', () => {
    assertEquals(compare('1.2.0', '1.1.0') > 0, true);
    assertEquals(compare('1.1.0', '1.2.0') < 0, true);
  });

  await t.step('compares patch versions', () => {
    assertEquals(compare('1.0.2', '1.0.1') > 0, true);
    assertEquals(compare('1.0.1', '1.0.2') < 0, true);
  });

  await t.step('stable > prerelease for same base', () => {
    assertEquals(compare('1.0.0', '1.0.0-alpha.0') > 0, true);
    assertEquals(compare('1.0.0', '1.0.0-rc.5') > 0, true);
  });

  await t.step('compares prerelease stages', () => {
    assertEquals(compare('1.0.0-beta.0', '1.0.0-alpha.0') > 0, true);
    assertEquals(compare('1.0.0-rc.0', '1.0.0-beta.0') > 0, true);
    assertEquals(compare('1.0.0-alpha.0', '1.0.0-beta.0') < 0, true);
  });

  await t.step('compares prerelease build numbers', () => {
    assertEquals(compare('1.0.0-alpha.5', '1.0.0-alpha.3') > 0, true);
    assertEquals(compare('1.0.0-alpha.3', '1.0.0-alpha.5') < 0, true);
    assertEquals(compare('1.0.0-alpha.5', '1.0.0-alpha.5'), 0);
  });

  await t.step('throws for invalid versions', () => {
    assertThrows(() => compare('invalid', '1.0.0'));
    assertThrows(() => compare('1.0.0', 'invalid'));
  });
});
