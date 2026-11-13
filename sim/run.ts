/**
 * Run scenarios against release tools inside the simulator and report.
 *
 *   deno run -A sim/run.ts [--tool pls,release-please] [--scenario lifecycle/] [--verbose]
 *
 * Verdicts:
 *   pass   every expectation held
 *   FAIL   an expectation did not hold (tool behaviour)
 *   n/a    the scenario does not apply to the tool
 *   gap    the tool needed something the simulator does not implement
 *   error  the harness itself failed
 */

import { parseArgs } from '@std/cli/parse-args';
import { type Scenario } from './scenario/steps.ts';
import { Expectation, NotApplicable, World } from './scenario/world.ts';
import { scenarios } from './scenarios/mod.ts';
import { tools } from './tools/mod.ts';
import type { Tool } from './tools/tool.ts';
import { repoRoot } from './tools/install.ts';

export interface Result {
  tool: string;
  scenario: string;
  group: string;
  title: string;
  verdict: 'pass' | 'FAIL' | 'n/a' | 'gap' | 'error';
  detail: string;
  ms: number;
  apiCalls: number;
  gitCalls: number;
  runs: number;
  notes: string[];
}

const SCENARIO_TIMEOUT_MS = 180_000;
const LEAK_GRACE_MS = 10_000;

/** Everything each workflow run printed, and every call it made: sim/out/logs/<tool>/<scenario>.log */
async function writeLog(w: World, result: Result): Promise<void> {
  const lines: string[] = [
    `${result.tool} ${result.scenario}: ${result.verdict}`,
    result.detail,
    '',
  ];
  for (const run of w.runner.runs) {
    lines.push(
      `=== ${run.id} ${run.workflow} [${run.event}${run.action ? '.' + run.action : ''}] ` +
        `${run.conclusion ?? run.status} at ${run.sha.slice(0, 7)}`,
    );
    for (const step of run.steps) {
      if (step.skipped) continue;
      lines.push(`--- step: ${step.name} (exit ${step.exitCode}, ${step.ms} ms)`);
      if (step.name === 'actions/checkout') continue;
      if (step.stdout.trim()) lines.push(step.stdout.trimEnd());
      if (step.stderr.trim()) lines.push('[stderr]', step.stderr.trimEnd());
    }
    lines.push('--- calls');
    for (const c of w.runner.callsOf(run)) {
      lines.push(
        `  ${String(c.status).padStart(3)} ${c.method.padEnd(6)} ${c.path.slice(0, 110)}${
          c.fault ? `  [fault: ${c.fault}]` : ''
        }`,
      );
    }
    lines.push('');
  }
  const dir = `${repoRoot}/sim/out/logs/${result.tool}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${result.scenario.replaceAll('/', '_')}.log`,
    lines.join('\n') + '\n',
  );
}

async function runOne(tool: Tool, scenario: Scenario, verbose: boolean): Promise<Result> {
  const started = performance.now();
  const base = {
    tool: tool.name,
    scenario: scenario.id,
    group: scenario.group,
    title: scenario.title,
  };
  let w: World | null = null;
  let verdict: Result['verdict'] = 'pass';
  let detail = '';
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    w = await World.create(tool, scenario.options);
    const timeout = new Promise<never>((_, reject) => {
      watchdog = setTimeout(
        () => reject(new Error(`scenario did not finish within ${SCENARIO_TIMEOUT_MS / 1000} s`)),
        SCENARIO_TIMEOUT_MS,
      );
    });
    await Promise.race([scenario.run(w), timeout]);
  } catch (e) {
    if (e instanceof NotApplicable) {
      verdict = 'n/a';
      detail = e.message;
    } else if (e instanceof Expectation) {
      verdict = 'FAIL';
      detail = e.message;
    } else {
      verdict = 'error';
      detail = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
    }
  }
  clearTimeout(watchdog);
  const calls = w?.sim.calls ?? [];
  const gaps = [...new Set(calls.filter((c) => c.unimplemented).map((c) => c.route))];
  if (gaps.length > 0 && verdict !== 'n/a') {
    verdict = 'gap';
    detail = `simulator does not implement: ${gaps.join('; ')}\n${detail}`;
  }
  if (verbose && w && verdict !== 'pass' && verdict !== 'n/a') {
    detail += `\n--- runs ---\n${w.runSummary(20)}`;
  }
  const result: Result = {
    ...base,
    verdict,
    detail: detail.trim(),
    ms: Math.round(performance.now() - started),
    apiCalls: calls.filter((c) => c.kind !== 'git').length,
    gitCalls: calls.filter((c) => c.kind === 'git').length,
    runs: w?.runner.runs.length ?? 0,
    notes: w?.notes ?? [],
  };
  if (w) await writeLog(w, result);
  await w?.close();
  return result;
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ['tool', 'scenario', 'out'],
    boolean: ['verbose', 'list'],
  });
  const toolFilter = args.tool ? args.tool.split(',') : null;
  const selectedTools = tools.filter((t) => !toolFilter || toolFilter.includes(t.name));
  const selected = scenarios.filter((s) => !args.scenario || s.id.includes(args.scenario));
  if (args.list) {
    for (const s of selected) console.log(`${s.id.padEnd(34)} ${s.title}`);
    Deno.exit(0);
  }

  const results: Result[] = [];
  const versions: Record<string, string> = {};
  for (const tool of selectedTools) {
    await tool.prepare?.();
    versions[tool.name] = await tool.version();
    console.log(`\n${tool.name} ${versions[tool.name]}`);
    for (const scenario of selected) {
      const r = await runOne(tool, scenario, args.verbose);
      results.push(r);
      const mark =
        { pass: 'pass ', FAIL: 'FAIL ', 'n/a': 'n/a  ', gap: 'gap  ', error: 'error' }[r.verdict];
      console.log(
        `  ${mark} ${scenario.id.padEnd(34)} ${String(r.ms).padStart(6)} ms  ${scenario.title}`,
      );
      if (r.verdict !== 'pass' && r.detail) {
        const lines = r.detail.split('\n');
        const shown = args.verbose ? lines : lines.slice(0, r.verdict === 'n/a' ? 1 : 6);
        for (const line of shown) console.log(`          ${line}`);
      }
      for (const n of r.notes) console.log(`          note: ${n}`);
    }
  }

  const outDir = args.out ?? `${repoRoot}/sim/out`;
  await Deno.mkdir(outDir, { recursive: true });
  await Deno.writeTextFile(
    `${outDir}/results.json`,
    JSON.stringify({ generatedAt: new Date().toISOString(), versions, results }, null, 2) + '\n',
  );

  console.log('\nSummary');
  for (const tool of selectedTools) {
    const mine = results.filter((r) => r.tool === tool.name);
    const count = (v: Result['verdict']) => mine.filter((r) => r.verdict === v).length;
    console.log(
      `  ${tool.name.padEnd(18)} pass ${count('pass')}  FAIL ${count('FAIL')}  n/a ${
        count('n/a')
      }` +
        `  gap ${count('gap')}  error ${count('error')}`,
    );
  }
  console.log(`\nResults written to ${outDir}/results.json`);

  // Nothing is left to do, so the process ends here unless a server, a timer or a
  // subprocess is still open. This timer does not hold the process open itself.
  Deno.unrefTimer(setTimeout(() => {
    console.error(
      `\nsim: the run finished ${LEAK_GRACE_MS / 1000} s ago and the process is still alive: ` +
        'a scenario left a server, a timer or a subprocess open. The results above are complete. ' +
        'Exiting with status 3.',
    );
    Deno.exit(3);
  }, LEAK_GRACE_MS));
}
