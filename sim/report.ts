/**
 * Turn sim/out/results.json into a Markdown report.
 *
 *   deno run -A sim/report.ts [--in sim/out/results.json] [--out sim/out/report.md]
 */

import { parseArgs } from '@std/cli/parse-args';
import type { Result } from './run.ts';
import { repoRoot } from './tools/install.ts';

interface ResultsFile {
  generatedAt: string;
  versions: Record<string, string>;
  results: Result[];
}

const SYMBOL: Record<Result['verdict'], string> = {
  pass: 'pass',
  FAIL: '**FAIL**',
  'n/a': 'n/a',
  gap: 'gap',
  error: 'error',
};

export function render(data: ResultsFile): string {
  const tools = Object.keys(data.versions);
  const scenarios: Array<{ id: string; group: string; title: string }> = [];
  for (const r of data.results) {
    if (!scenarios.some((s) => s.id === r.scenario)) {
      scenarios.push({ id: r.scenario, group: r.group, title: r.title });
    }
  }
  const find = (tool: string, scenario: string) =>
    data.results.find((r) => r.tool === tool && r.scenario === scenario);
  const lines: string[] = [];

  lines.push('# Release tool simulation report', '');
  lines.push(`Generated ${data.generatedAt.slice(0, 10)}.`, '');
  lines.push('| Tool | Version under test |', '|---|---|');
  for (const t of tools) lines.push(`| ${t} | ${data.versions[t]} |`);
  lines.push('');

  lines.push('## Summary', '');
  lines.push('| Tool | pass | FAIL | n/a | gap | error |', '|---|---:|---:|---:|---:|---:|');
  const scored = scenarios.filter((s) => s.group !== 'Observations').map((s) => s.id);
  for (const t of tools) {
    const mine = data.results.filter((r) => r.tool === t && scored.includes(r.scenario));
    const n = (v: Result['verdict']) => mine.filter((r) => r.verdict === v).length;
    lines.push(
      `| ${t} | ${n('pass')} | ${n('FAIL')} | ${n('n/a')} | ${n('gap')} | ${n('error')} |`,
    );
  }
  lines.push('');

  const groups = [...new Set(scenarios.map((s) => s.group))];
  for (const group of groups) {
    if (group === 'Observations') continue;
    lines.push(`## ${group}`, '');
    lines.push(`| Scenario | ${tools.join(' | ')} |`, `|---|${tools.map(() => '---').join('|')}|`);
    for (const s of scenarios.filter((x) => x.group === group)) {
      const cells = tools.map((t) => SYMBOL[find(t, s.id)?.verdict ?? 'n/a']);
      lines.push(`| ${s.title} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  lines.push('## Observations', '');
  for (const s of scenarios.filter((x) => x.group === 'Observations')) {
    lines.push(`### ${s.title}`, '');
    for (const t of tools) {
      const r = find(t, s.id);
      if (!r) continue;
      const notes = r.notes.length > 0
        ? r.notes.join('; ')
        : `${r.verdict}: ${r.detail.split('\n')[0]}`;
      lines.push(`- **${t}**: ${notes}`);
    }
    lines.push('');
  }

  lines.push('## Failures in detail', '');
  for (const t of tools) {
    const failed = data.results.filter((r) =>
      r.tool === t && (r.verdict === 'FAIL' || r.verdict === 'gap' || r.verdict === 'error')
    );
    if (failed.length === 0) continue;
    lines.push(`### ${t}`, '');
    for (const r of failed) {
      lines.push(`**${r.title}** (\`${r.scenario}\`, ${r.verdict})`, '');
      lines.push('```', ...r.detail.split('\n').slice(0, 14), '```', '');
    }
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const args = parseArgs(Deno.args, { string: ['in', 'out'] });
  const input = args.in ?? `${repoRoot}/sim/out/results.json`;
  const output = args.out ?? `${repoRoot}/sim/out/report.md`;
  const data = JSON.parse(await Deno.readTextFile(input)) as ResultsFile;
  await Deno.writeTextFile(output, render(data) + '\n');
  console.log(`Report written to ${output}`);
}
