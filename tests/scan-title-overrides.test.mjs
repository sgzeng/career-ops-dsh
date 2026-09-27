// tests/scan-title-overrides.test.mjs — scan.mjs honors tracked_title_overrides
// for tracked_companies, keyed by the entry name (fork-local, 2026-09-26).
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execFileSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nscan.mjs — tracked_title_overrides for tracked companies');

try {
  const { buildScanTitleFilter, buildTitleFilter } = await import(pathToFileURL(join(ROOT, 'scan.mjs')).href);

  const title_filter = {
    positive: ['Security Researcher', 'Vulnerability Research'],
    negative: ['Manager', 'word:Sales', 'Site Reliability'],
  };
  const config = {
    title_filter,
    tracked_title_overrides: [
      { companies: ['Armadin', 'Cogent Security'], positive_extra: ['Member of Technical Staff', 'Research Engineer', 'stem:Agent'] },
    ],
  };
  const f = buildScanTitleFilter(config);

  if (f('Member of Technical Staff - Research', 'Armadin') && f('AI Research Engineer', 'cogent security')) {
    pass('a listed company passes on positive_extra (entry name, case-insensitive)');
  } else {
    fail('listed company should pass on positive_extra');
  }

  if (!f('Member of Technical Staff - Research', 'NVIDIA') && !f('AI Research Engineer', undefined)) {
    pass('an unlisted company (or no name) keeps the global title gate');
  } else {
    fail('unlisted company must not get the broadened net');
  }

  if (!f('Member of Technical Staff - Site Reliability', 'Armadin') && !f('Research Engineer Manager', 'Armadin')) {
    pass('global negatives still veto a positive_extra match');
  } else {
    fail('global negatives should veto positive_extra matches');
  }

  if (f('Senior Software Engineer - Agents', 'Armadin') && f('Security Researcher', 'NVIDIA')) {
    pass('stem: prefixes work in positive_extra; global positives unaffected');
  } else {
    fail('stem:Agent / global positive check failed');
  }

  // title_filter_overrides belongs to scan-ats-full.mjs (board slugs) — scan.mjs ignores it.
  const slugOnly = buildScanTitleFilter({ title_filter, title_filter_overrides: [{ companies: ['armadin'], positive_extra: ['Member of Technical Staff'] }] });
  if (!slugOnly('Member of Technical Staff - Research', 'Armadin')) {
    pass('scan.mjs ignores title_filter_overrides (scan-ats-full slug key)');
  } else {
    fail('scan.mjs must read tracked_title_overrides, not title_filter_overrides');
  }

  const plain = buildScanTitleFilter({ title_filter });
  const base = buildTitleFilter(title_filter);
  const samples = ['Security Researcher', 'Member of Technical Staff', 'Sales Security Researcher', 'Vulnerability Research Intern'];
  if (samples.every(t => plain(t, 'Armadin') === base(t))) {
    pass('without tracked_title_overrides the gate equals buildTitleFilter(title_filter)');
  } else {
    fail('no-override gate diverged from buildTitleFilter');
  }
} catch (e) {
  fail(`scan title override tests crashed: ${e.message}`);
}

// validate-portals knows tracked_title_overrides and warns on a name that matches
// no tracked company (run as a CLI: importing it runs main(), which may exit).
try {
  const tmp = mkdtempSync(join(tmpdir(), 'co-tto-'));
  const check = (body) => {
    const file = join(tmp, `p${Math.abs(body.length)}.yml`);
    writeFileSync(file, body, 'utf-8');
    try {
      return { code: 0, out: execFileSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (e) {
      return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
    }
  };
  const tracked = 'tracked_companies:\n  - name: Armadin\n    careers_url: https://jobs.ashbyhq.com/armadin\n';
  const ok = check(`${tracked}tracked_title_overrides:\n  - companies: [armadin]\n    positive_extra: ["Member of Technical Staff"]\n`);
  const typo = check(`${tracked}tracked_title_overrides:\n  - companies: [armadin, Armadn]\n    positive_extra: ["Member of Technical Staff"]\n`);
  const bad = check(`${tracked}tracked_title_overrides:\n  companies: [armadin]\n`);
  if (ok.code === 0 && /0 errors, 0 warnings/.test(ok.out)
    && typo.code === 0 && /Armadn/.test(typo.out) && !/"armadin"/.test(typo.out)
    && bad.code !== 0 && /tracked_title_overrides/.test(bad.out)) {
    pass('validate-portals accepts tracked_title_overrides, warns on an unmatched name, rejects a non-array');
  } else {
    fail(`validate-portals tracked_title_overrides: ok=${JSON.stringify(ok)} typo=${JSON.stringify(typo)} bad=${JSON.stringify(bad)}`);
  }
  rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  fail(`validate-portals tracked_title_overrides tests crashed: ${e.message}`);
}
