// tests/visa-export-license.test.mjs — export-control boilerplate is not a
// visa refusal.
//
// Cloudflare ends every JD with "...controlled under these U.S. export laws
// without sponsorship for an export license". Once Greenhouse descriptions were
// read in full (FULL_DESCRIPTION_CAP), the "without sponsorship" negative matched
// that sentence and buildVisaFilter dropped all 382 Cloudflare postings.
import { pass, fail } from './helpers.mjs';
import { buildVisaFilter, DEFAULT_VISA_NEGATIVE } from '../scan.mjs';

console.log('\nscan.mjs — visa filter vs export-license boilerplate');

const CLOUDFLARE = 'We build a better Internet. Some roles may involve access to technology '
  + 'controlled under these U.S. export laws without sponsorship for an export license. '
  + 'Cloudflare is proud to be an equal opportunity employer.';

{
  if (DEFAULT_VISA_NEGATIVE.includes('without sponsorship')) pass('precondition: defaults contain "without sponsorship"');
  else fail('precondition changed: "without sponsorship" no longer a default negative');

  if (buildVisaFilter({ enabled: true })(CLOUDFLARE)) pass('default negatives keep the Cloudflare export-license posting');
  else fail('default visa filter dropped export-license boilerplate');

  const user = buildVisaFilter({ enabled: true, negative: ['no sponsorship', 'without sponsorship'] });
  if (user(CLOUDFLARE)) pass('a user negative list keeps it too');
  else fail('user visa negatives dropped export-license boilerplate');

  const real = `${CLOUDFLARE} Candidates must be able to work without sponsorship now or in the future.`;
  if (!user(real)) pass('a genuine "without sponsorship" statement in the same JD still drops it');
  else fail('neutralizing export-license text also hid a real no-sponsorship statement');

  const licenses = 'Work may require sponsorship for a U.S. export license; we do not sponsor visas.';
  if (!buildVisaFilter({ enabled: true })(licenses)) pass('"do not sponsor" elsewhere still drops the posting');
  else fail('visa refusal missed next to export-license wording');
}
