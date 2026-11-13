/**
 * pre-receive hook for simulated repositories.
 *
 * Enforces the same rulesets on git pushes that model.ts enforces on API ref
 * updates: restricted tag creation, tags locked by immutable releases, and
 * protected branches. The smart-HTTP layer sets SIM_ACTOR_KIND to the kind of
 * credential that authenticated the push.
 */

interface Rules {
  tag: { pattern: string; bypass: string[] } | null;
  branches: Array<{ pattern: string; bypass: string[] }>;
  locked: string[];
}

const rules: Rules = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const kind = Deno.env.get('SIM_ACTOR_KIND') ?? 'web';
const zero = /^0+$/;
const input = await new Response(Deno.stdin.readable).text();
const violations: string[] = [];

for (const line of input.split('\n')) {
  if (!line.trim()) continue;
  const [oldSha, , ref] = line.split(' ');
  if (ref.startsWith('refs/tags/')) {
    const name = ref.slice('refs/tags/'.length);
    if (rules.locked.includes(name)) {
      violations.push(`${ref}: tag is locked by an immutable release`);
    } else if (
      rules.tag && zero.test(oldSha) && new RegExp(rules.tag.pattern).test(name) &&
      !rules.tag.bypass.includes(kind)
    ) {
      violations.push(`${ref}: Cannot create ref due to creations being restricted.`);
    }
  } else if (ref.startsWith('refs/heads/')) {
    const name = ref.slice('refs/heads/'.length);
    for (const rule of rules.branches) {
      if (new RegExp(rule.pattern).test(name) && !rule.bypass.includes(kind)) {
        violations.push(`${ref}: Changes must be made through a pull request.`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error('error: GH013: Repository rule violations found.');
  for (const v of violations) console.error(`- ${v}`);
  Deno.exit(1);
}
