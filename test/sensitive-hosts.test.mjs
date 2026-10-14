// Bundled sensitive-site list and host matching (shared/hosts.js) over real hostnames.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../shared/hosts.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context, { filename: 'hosts.js' });
const { hostMatchesDomain, matchesAnyDomain, isSensitiveHost, isSensitivePage } = context.LangslyHosts;

test('domain entries match the host itself or its subdomains only', () => {
  assert.equal(hostMatchesDomain('x.com', 'x.com'), true);
  assert.equal(hostMatchesDomain('mobile.x.com', 'x.com'), true);
  assert.equal(hostMatchesDomain('netflix.com', 'x.com'), false);
  assert.equal(hostMatchesDomain('bank.com.evil.test', 'bank.com'), false);
  assert.equal(hostMatchesDomain('notbank.com', 'bank.com'), false);
  assert.equal(hostMatchesDomain('WWW.Example.TEST.', '.example.test'), true);
  assert.equal(hostMatchesDomain('example.test', ''), false);
  assert.equal(matchesAnyDomain('news.example.test', ['news']), false);
  assert.equal(matchesAnyDomain('news.example.test', 'example.test'), false, 'non-array lists match nothing');
});

test('signed-in banks, card issuers and payment apps are excluded', () => {
  for (const host of [
    'secure.chase.com', 'www.bankofamerica.com', 'connect.secure.wellsfargo.com', 'online.citi.com', 'onlinebanking.usbank.com',
    'verified.capitalone.com', 'global.americanexpress.com', 'portal.discover.com', 'www.navyfederal.org', 'www.usaa.com',
    'www.paypal.com', 'account.venmo.com', 'client.schwab.com', 'digital.fidelity.com', 'www.bbva.mx', 'www.banorte.com',
    'www.santander.com.mx', 'bancanet.banamex.com', 'www.bancoazteca.com.mx', 'www.mercadopago.com.mx', 'www.bbva.es',
    'www.caixabank.es', 'www.bancsabadell.com', 'app.revolut.com', 'banking.americafirst.com', 'my.ally.com',
    'www.examplefcu.org', 'online.bancomercantil.com', 'bankwest.example',
  ]) assert.equal(isSensitiveHost(host), true, host);
});

test('patient portals, pharmacies and insurers are excluded', () => {
  for (const host of [
    'mychart.example-hospital.org', 'mychart.sutterhealth.org', 'healthy.kaiserpermanente.org', 'kp.org',
    'www.followmyhealth.com', '12345.portal.athenahealth.com', 'www.myuhc.com', 'member.aetna.com', 'www.cvs.com',
    'www.walgreens.com', 'patient.labcorp.com', 'myquest.questdiagnostics.com', 'www.quironsalud.com', 'area-privada.sanitas.es',
    'paciente.imss.gob.mx', 'www.healthcare.gov',
  ]) assert.equal(isSensitiveHost(host), true, host);
});

test('webmail, chat and private documents are excluded', () => {
  for (const host of [
    'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.yahoo.com', 'mail.proton.me', 'www.icloud.com',
    'web.whatsapp.com', 'www.messenger.com', 'web.telegram.org', 'discord.com', 'app.slack.com', 'teams.microsoft.com',
    'docs.google.com', 'drive.google.com', 'contoso.sharepoint.com', 'webmail.example.test',
  ]) assert.equal(isSensitiveHost(host), true, host);
  assert.equal(isSensitivePage('www.instagram.com', '/direct/inbox/'), true);
  assert.equal(isSensitivePage('www.facebook.com', '/messages/t/123'), true);
  assert.equal(isSensitivePage('www.linkedin.com', '/messaging/'), true);
  assert.equal(isSensitivePage('x.com', '/messages'), true);
});

test('ordinary reading sites stay enabled', () => {
  for (const [host, path] of [
    ['www.bbc.com', '/news'], ['es.wikipedia.org', '/wiki/Madrid'], ['www.nytimes.com', '/2026/10/01/world.html'],
    ['elpais.com', '/espana/'], ['www.reddit.com', '/r/Spanish/'], ['x.com', '/langsly'], ['www.instagram.com', '/langsly/'],
    ['www.facebook.com', '/langsly'], ['news.example.test', '/article'], ['www.amazon.com', '/dp/B000'],
    ['medium.com', '/@writer/post'], ['www.netflix.com', '/browse'],
  ]) assert.equal(isSensitivePage(host, path), false, `${host}${path}`);
});
