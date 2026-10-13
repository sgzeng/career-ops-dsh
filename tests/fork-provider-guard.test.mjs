// tests/fork-provider-guard.test.mjs — fork guard: upstream's adp-workforcenow provider must not come back.
//
// Upstream ships providers/adp-workforcenow.mjs next to the fork's providers/adp.mjs. Both claim
// workforcenow.adp.com links, the registry loads providers alphabetically ("adp-workforcenow" sorts
// before "adp.") and the first detect() hit wins, so the upstream file silently takes over every ADP
// tenant (ThreatLocker today) and swaps the fork's default full-text JD fetch (20k chars) for
// upstream's opt-in 4000-char one — which blinds content_filter and level_filter.
//
// The file was deleted on purpose (sync of 2026-10-06). Nothing stops it returning: a merge can bring
// it back without a conflict, and update-system.mjs apply re-checks out the whole providers/ directory
// and treats a file missing on disk as "nothing of yours to overwrite". This test fails loudly instead.
import { existsSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.mjs';
import { loadProviders, resolveProvider } from '../providers/_registry.mjs';

console.log('\nFork guard — ADP provider ownership');

try {
  const upstreamFile = join(ROOT, 'providers/adp-workforcenow.mjs');
  const upstreamTest = join(ROOT, 'tests/providers/adp-workforcenow.test.mjs');

  if (!existsSync(upstreamFile)) pass('providers/adp-workforcenow.mjs is absent (the fork providers/adp.mjs owns ADP)');
  else fail('providers/adp-workforcenow.mjs is back: it sorts before adp.mjs and takes over ADP tenants; delete it (and its test) again');

  if (!existsSync(upstreamTest)) pass('tests/providers/adp-workforcenow.test.mjs is absent');
  else fail('tests/providers/adp-workforcenow.test.mjs is back: delete it together with the upstream provider');

  const providers = await loadProviders(join(ROOT, 'providers'));
  if (!providers.has('adp-workforcenow')) pass('provider registry has no adp-workforcenow id');
  else fail('provider registry loads adp-workforcenow — it would shadow the fork adp provider');

  // Fictional tenant: the shape of the real URL, not a real cid.
  const entry = {
    name: 'Acme',
    careers_url: 'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=11111111-2222-4333-8444-555555555555&ccId=19000101_000001&lang=en_US',
  };
  const hit = resolveProvider(entry, providers);
  const id = hit && hit.provider ? hit.provider.id : null;
  if (id === 'adp') pass('a workforcenow.adp.com careers_url resolves to the fork adp provider');
  else fail(`a workforcenow.adp.com careers_url resolves to "${id}", expected "adp"`);
} catch (e) {
  fail(`fork provider guard crashed: ${e.stack || e.message}`);
}
