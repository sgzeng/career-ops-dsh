// tests/validate-portals-company-eid.test.mjs — validate-portals knows the
// jobvite provider's documented `company_eid` entry field (providers/jobvite.mjs
// resolution step 1) and does not warn on it as a typo; an unknown field still warns.
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { pass, fail, ROOT, NODE, rmSync } from './helpers.mjs';

console.log('\nvalidate-portals — jobvite company_eid');

const tmp = mkdtempSync(join(tmpdir(), 'co-vp-eid-'));
try {
  const run = (field) => {
    const file = join(tmp, `${field}.yml`);
    writeFileSync(file, `tracked_companies:\n  - name: Varonis\n    careers_url: https://jobs.jobvite.com/varonis\n    ${field}: qTjaVfw1\n    enabled: true\n`, 'utf-8');
    try {
      return execFileSync(NODE, [join(ROOT, 'validate-portals.mjs'), '--file', file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return `${e.stdout || ''}${e.stderr || ''}`;
    }
  };
  const ok = run('company_eid');
  const typo = run('company_ied');
  (/0 errors, 0 warnings/.test(ok) && /company_ied: unknown company field/.test(typo))
    ? pass('company_eid is a known entry field; a misspelling still warns')
    : fail(`company_eid: ok=${ok} typo=${typo}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
