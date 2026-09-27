// tests/check-config-regression.test.mjs — ops/check-config-regression.mjs (the
// WARN-only filter preflight in ops/daily-scan.sh): title_net / company fixtures,
// their guards, and the exit codes. Run as a CLI against temp files.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nops/check-config-regression.mjs — title_net / company fixtures');

const tmp = mkdtempSync(join(tmpdir(), 'co-regress-'));
let n = 0;
const run = (portals, fixtures) => {
  const p = join(tmp, `p${n}.yml`);
  const f = join(tmp, `f${n++}.json`);
  writeFileSync(p, portals, 'utf-8');
  if (fixtures !== null) writeFileSync(f, typeof fixtures === 'string' ? fixtures : JSON.stringify(fixtures), 'utf-8');
  try {
    return { code: 0, out: execFileSync(NODE, [join(ROOT, 'ops/check-config-regression.mjs'), '--portals', p, '--fixtures', f], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
};

const portals = (tag) => `title_filter:
  positive: ["Security Researcher"]
  negative: ["Manager"]
title_nets:
  security: ["Member of Technical Staff"]
tracked_companies:
  - name: Armadin
    careers_url: https://jobs.ashbyhq.com/armadin
${tag ? '    title_net: security\n' : ''}    enabled: true
`;
const mts = 'Member of Technical Staff - Research';

try {
  const withNet = run(portals(true), { titles_kept: [{ text: mts, title_net: 'security', company: 'Armadin' }], titles_dropped: [mts] });
  (withNet.code === 0 && /✅ 2\/2/.test(withNet.out))
    ? pass('a net fixture passes with the net, and the same title without it stays dropped')
    : fail(`with net: ${JSON.stringify(withNet)}`);

  const untagged = run(portals(false), { titles_kept: [{ text: mts, title_net: 'security', company: 'Armadin' }] });
  (untagged.code === 1 && /company "Armadin" is tagged title_net: null/.test(untagged.out))
    ? pass('removing the company\'s title_net breaks its fixture (company check)')
    : fail(`untagged company: ${JSON.stringify(untagged)}`);

  const unknownNet = run(portals(true), { titles_kept: [{ text: mts, title_net: 'Security' }] });
  (unknownNet.code === 1 && /names no title_nets entry/.test(unknownNet.out))
    ? pass('an unknown (or wrong-case) net fails the case instead of reading as "no net"')
    : fail(`unknown net: ${JSON.stringify(unknownNet)}`);

  const locNet = run(portals(true), { locations_kept: [{ text: 'San Francisco, CA', title_net: 'security' }] });
  (locNet.code === 1 && /apply to titles_\* cases only/.test(locNet.out))
    ? pass('title_net on a locations_* case fails')
    : fail(`location net: ${JSON.stringify(locNet)}`);

  const plain = run(portals(true), { titles_kept: ['Senior Security Researcher'], titles_dropped: ['Engineering Manager'] });
  (plain.code === 0 && /✅ 2\/2 filter fixtures hold/.test(plain.out))
    ? pass('plain string fixtures behave as before')
    : fail(`plain: ${JSON.stringify(plain)}`);

  const none = run(portals(true), null);
  const badYaml = run('title_filter: [', { titles_kept: [] });
  (none.code === 0 && /nothing to check/.test(none.out) && badYaml.code === 2)
    ? pass('no fixtures file → exit 0; unparseable portals.yml → exit 2')
    : fail(`exit codes: none=${JSON.stringify(none)} bad=${JSON.stringify(badYaml)}`);
} catch (e) {
  fail(`check-config-regression tests crashed: ${e.message}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
