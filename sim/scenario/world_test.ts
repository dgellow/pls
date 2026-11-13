/**
 * Tests of the scenario harness: what it must guarantee whatever a tool does.
 *
 * Deno's test runner fails a test that leaves a listener, a connection or a
 * subprocess open, which is what the first test relies on.
 */

import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Tool } from '../tools/tool.ts';
import { conventional } from '../tools/tool.ts';
import { headingNames } from './steps.ts';
import { World } from './world.ts';

function stubTool(adopt: Tool['adopt']): Tool {
  return {
    name: 'stub',
    capabilities: [],
    version: () => Promise.resolve('0'),
    adopt,
    workflows: () => [],
    change: (_w, change) => conventional(change),
    releasePR: () => undefined,
    tagName: (version) => `v${version}`,
    versionAt: () => Promise.resolve(null),
  };
}

Deno.test('world: a tool that cannot be adopted leaves no server behind', async () => {
  let port = 0;
  await assertRejects(
    () =>
      World.create(stubTool((w) => {
        port = w.sim.port;
        throw new Error('tool binary is missing');
      })),
    Error,
    'tool binary is missing',
  );
  assert(port > 0, 'the simulated GitHub was started before adoption');
  await assertRejects(
    () => Deno.connect({ hostname: '127.0.0.1', port }),
    Deno.errors.ConnectionRefused,
  );
});

Deno.test('world: a request to the npm registry stays inside the simulator and is a gap', async () => {
  const w = await World.create(stubTool(async (w) => {
    await w.commit('chore: initial commit', { 'README.md': '# widget\n' });
    await w.sh('git push -q origin main');
  }));
  try {
    const registry = (await w.sh('npm config get registry')).trim();
    assertEquals(registry, w.sim.npmRegistryUrl);
    w.runner.workflows = [{
      name: 'publish',
      on: [{ event: 'push', branches: ['main'] }],
      steps: [{ name: 'ask the registry', run: 'npm view widget version' }],
    }];
    await w.land('feat: add export command');
    const calls = w.sim.calls.filter((c) => c.path.startsWith('/npm-registry/'));
    assert(calls.length > 0, 'the registry request did not reach the simulator');
    assert(calls.every((c) => c.unimplemented), 'registry requests must be reported as a gap');
  } finally {
    await w.close();
  }
});

Deno.test('steps: a changelog heading names a version only as a whole word', () => {
  assert(headingNames('## 1.1.0', '1.1.0'));
  assert(headingNames('## [1.1.0](http://host/compare/v1.0.0...v1.1.0) (2026-11-13)', '1.1.0'));
  assert(headingNames('# v1.1.0', '1.1.0') === false, 'v1.1.0 is one word');
  assert(headingNames('## 11.1.0', '1.1.0') === false);
  assert(headingNames('## 1.1.01', '1.1.0') === false);
  assert(headingNames('## 1x1y0', '1.1.0') === false, 'a dot is not a wildcard');
  assert(headingNames('- fixed in 1.1.0', '1.1.0') === false, 'not a heading');
  assert(headingNames('## 1.1.0+build.5', '1.1.0+build.5'));
  assert(headingNames('## 1.1.0\\d', '1.1.0\\d'), 'a backslash is plain text');
});
