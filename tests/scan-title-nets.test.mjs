// tests/scan-title-nets.test.mjs — scan.mjs's title gate honors portals.yml
// `title_nets` for tracked_companies tagged `title_net: <name>` (fork-local, 2026-09-26).
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — title_nets for tagged tracked companies');

try {
  const { buildScanTitleFilter, buildTitleFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const title_filter = {
    positive: ['Security Researcher', 'Vulnerability Research'],
    negative: ['Manager', 'word:Sales', 'Site Reliability'],
  };
  const config = {
    title_filter,
    title_nets: { security: ['Member of Technical Staff', 'Research Engineer', 'stem:Agent'] },
  };
  const f = buildScanTitleFilter(config);

  if (f('Member of Technical Staff - Research', 'security') && f('AI Research Engineer', 'security')) {
    pass('an entry tagged with a net passes on that net\'s keywords');
  } else {
    fail('tagged entry should pass on its net');
  }

  if (!f('Member of Technical Staff - Research', undefined) && !f('AI Research Engineer', 'nope')) {
    pass('an untagged entry (or an unknown net) keeps the global title gate');
  } else {
    fail('untagged entry must not get the broadened net');
  }

  if (!f('Member of Technical Staff - Site Reliability', 'security') && !f('Research Engineer Manager', 'security')) {
    pass('global negatives still veto a net match');
  } else {
    fail('global negatives should veto net matches');
  }

  if (f('Senior Software Engineer - Agents', 'security') && f('Security Researcher', undefined)) {
    pass('stem: prefixes work in a net; global positives unaffected');
  } else {
    fail('stem:Agent / global positive check failed');
  }

  // title_filter_overrides belongs to scan-ats-full.mjs (board slugs) — scan.mjs ignores it.
  const slugOnly = buildScanTitleFilter({ title_filter, title_filter_overrides: [{ companies: ['security'], positive_extra: ['Member of Technical Staff'] }] });
  if (!slugOnly('Member of Technical Staff - Research', 'security')) {
    pass('scan.mjs ignores title_filter_overrides (scan-ats-full slug key)');
  } else {
    fail('scan.mjs must read title_nets, not title_filter_overrides');
  }

  const plain = buildScanTitleFilter({ title_filter });
  const bogus = buildScanTitleFilter({ title_filter, title_nets: ['not', 'a', 'map'] });
  const base = buildTitleFilter(title_filter);
  const samples = ['Security Researcher', 'Member of Technical Staff', 'Sales Security Researcher', 'Vulnerability Research Intern'];
  if (samples.every(t => plain(t, 'security') === base(t) && bogus(t, 'security') === base(t))) {
    pass('without (or with a malformed) title_nets the gate equals buildTitleFilter(title_filter)');
  } else {
    fail('no-net gate diverged from buildTitleFilter');
  }
} catch (e) {
  fail(`scan title net tests crashed: ${e.message}`);
}

// validate-portals knows title_nets / title_net and errors on an undefined net
// (run as a CLI: importing it runs main(), which may exit).
try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-titlenet-'));
  let n = 0;
  const check = (body) => {
    const file = join(tmp, `p${n++}.yml`);
    writeFileSync(file, body, 'utf-8');
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const nets = 'title_nets:\n  security: ["Member of Technical Staff"]\n';
  const entry = (tag) => `tracked_companies:\n  - name: Armadin\n    careers_url: https://jobs.ashbyhq.com/armadin\n    title_net: ${tag}\n`;
  const ok = check(nets + entry('security'));
  const typo = check(nets + entry('securty'));
  const badNet = check('title_nets:\n  security: "Member of Technical Staff"\n' + entry('security'));
  if (ok.code === 0 && /0 errors, 0 warnings/.test(ok.out)
    && typo.code !== 0 && /securty/.test(typo.out)
    && badNet.code !== 0 && /title_nets\.security/.test(badNet.out)) {
    pass('validate-portals accepts title_nets + title_net, rejects an undefined net and a non-list net');
  } else {
    fail(`validate-portals title_nets: ok=${JSON.stringify(ok)} typo=${JSON.stringify(typo)} badNet=${JSON.stringify(badNet)}`);
  }
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`validate-portals title_nets tests crashed: ${e.message}`);
}
