// Host matching and the bundled sensitive-site list, shared by the content script,
// the popup and the service worker. Loaded as a classic script (no modules).
(function initLangslyHosts(global) {
  function normalizeHost(value) {
    return String(value || '').trim().toLowerCase().replace(/\.+$/, '');
  }

  function normalizeDomain(value) {
    return normalizeHost(value).replace(/^\*?\./, '');
  }

  // A configured domain covers itself and its subdomains only: "bank.com" matches
  // "bank.com" and "www.bank.com", never "notbank.com" or "bank.com.evil.test".
  function hostMatchesDomain(host, domain) {
    const h = normalizeHost(host);
    const d = normalizeDomain(domain);
    return Boolean(h && d) && (h === d || h.endsWith(`.${d}`));
  }

  function matchesAnyDomain(host, domains) {
    return Array.isArray(domains) && domains.some(domain => hostMatchesDomain(host, domain));
  }

  // Vocab Pass never runs on these sites: signed-in banking, card, payment and
  // brokerage dashboards, patient portals and health insurers, webmail, chat and
  // private documents. Matched by exact host or dot-suffix.
  const SENSITIVE_DOMAINS = Object.freeze([
    // Banks, card issuers, payments and brokerages (US)
    'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'usbank.com', 'pnc.com',
    'capitalone.com', 'tdbank.com', 'td.com', 'truist.com', 'regions.com', '53.com', 'fifththird.com', 'key.com',
    'huntington.com', 'citizensbank.com', 'mtb.com', 'bmo.com', 'santanderbank.com', 'ally.com', 'sofi.com',
    'discover.com', 'americanexpress.com', 'synchrony.com', 'mysynchrony.com', 'barclaycardus.com', 'barclays.com',
    'navyfederal.org', 'usaa.com', 'penfed.org', 'becu.org', 'americafirst.com', 'golden1.com', 'schoolsfirstfcu.org',
    'chime.com', 'varo.com', 'venmo.com', 'cash.app', 'zellepay.com', 'paypal.com', 'wise.com', 'remitly.com',
    'westernunion.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'etrade.com', 'merrilledge.com', 'robinhood.com',
    'coinbase.com', 'creditkarma.com', 'experian.com', 'equifax.com', 'transunion.com',
    // Banks and payments (MX)
    'bbva.mx', 'banorte.com', 'santander.com.mx', 'banamex.com', 'citibanamex.com', 'hsbc.com.mx', 'scotiabank.com.mx',
    'bancoazteca.com.mx', 'inbursa.com', 'banregio.com', 'bancoppel.com', 'afirme.com', 'bancomer.com',
    'mercadopago.com', 'mercadopago.com.mx', 'spinbyoxxo.com.mx', 'nu.com.mx', 'heybanco.com',
    // Banks and payments (ES and EU)
    'bbva.es', 'bbva.com', 'santander.es', 'bancosantander.es', 'caixabank.es', 'caixabank.com', 'bankinter.com',
    'bancsabadell.com', 'sabadell.com', 'ing.es', 'openbank.es', 'unicajabanco.es', 'kutxabank.es', 'abanca.com',
    'ibercaja.es', 'evobanco.com', 'bancamarch.es', 'cajamar.es', 'cajarural.com', 'revolut.com', 'n26.com', 'bizum.es',
    // Patient portals, pharmacies, labs and health insurers
    'mychart.com', 'mychart.org', 'kp.org', 'kaiserpermanente.org', 'followmyhealth.com', 'athenahealth.com',
    'athenapatient.com', 'healow.com', 'nextmd.com', 'patientportal.com', 'myuhc.com', 'uhc.com', 'aetna.com',
    'cigna.com', 'anthem.com', 'bcbs.com', 'humana.com', 'molinahealthcare.com', 'cvs.com', 'walgreens.com',
    'goodrx.com', 'zocdoc.com', 'teladoc.com', 'labcorp.com', 'questdiagnostics.com', 'onemedical.com',
    'sanitas.es', 'adeslas.es', 'segurcaixaadeslas.es', 'dkv.es', 'dkvseguros.com', 'asisa.es',
    // Webmail
    'mail.google.com', 'inbox.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com',
    'mail.yahoo.com', 'mail.aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'mail.zoho.com', 'fastmail.com',
    'gmx.com', 'gmx.net', 'gmx.es', 'tuta.com', 'tutanota.com', 'hey.com',
    // Chat and messaging
    'web.whatsapp.com', 'whatsapp.com', 'messenger.com', 'web.telegram.org', 'discord.com', 'slack.com',
    'teams.microsoft.com', 'teams.live.com', 'chat.google.com', 'messages.google.com', 'voice.google.com',
    'chat.reddit.com',
    // Private documents and storage
    'docs.google.com', 'drive.google.com', 'onedrive.live.com', 'sharepoint.com', 'dropbox.com', 'box.com',
  ]);

  // Signed-in sections of otherwise public sites.
  const SENSITIVE_PATHS = Object.freeze([
    ['instagram.com', /^\/direct(\/|$)/i],
    ['facebook.com', /^\/messages(\/|$)/i],
    ['linkedin.com', /^\/messaging(\/|$)/i],
    ['x.com', /^\/(messages|i\/chat)(\/|$)/i],
    ['twitter.com', /^\/messages(\/|$)/i],
    ['reddit.com', /^\/(message|chat)(\/|$)/i],
    ['amazon.com', /^\/(gp\/(css|your-account)|your-account|cpe\/yourpayments)(\/|$)/i],
  ]);

  // Host labels that mark banking, health and other private services.
  const SENSITIVE_HOST_PATTERNS = Object.freeze([
    /(^|[.-])(bank|banking|paypal|stripe|checkout|payment|payments|wallet|billing)([.-]|$)/i,
    /(^|[.-])(health|medical|patient|pharmacy|insurance|medicare|medicaid|clinic|hospital)([.-]|$)/i,
    /(^|[.-])(legal|attorney|court|law)([.-]|$)/i,
    /(^|[.-])(login|signin|auth|account|accounts|sso|mail|webmail|portal)([.-]|$)/i,
    /\.(gov|gob|mil)(\.[a-z]{2})?$/i,
  ]);

  // Label-prefix/infix rules: bank*, banc* (banco, banca, bancomer), *health*,
  // *salud*, *mychart*, *patient*/*paciente*, *credit-union*/*fcu*.
  function labelLooksSensitive(label) {
    return /^(bank|banc)/.test(label)
      || /(health|salud|mychart|patient|paciente|creditunion|hospital)/.test(label)
      || /^.+fcu$/.test(label);
  }

  function isSensitiveHost(host) {
    const h = normalizeHost(host);
    if (!h) return false;
    if (matchesAnyDomain(h, SENSITIVE_DOMAINS)) return true;
    if (SENSITIVE_HOST_PATTERNS.some(pattern => pattern.test(h))) return true;
    return h.split('.').some(labelLooksSensitive);
  }

  function isSensitivePage(host, path) {
    if (isSensitiveHost(host)) return true;
    const p = String(path || '/');
    return SENSITIVE_PATHS.some(([domain, pattern]) => hostMatchesDomain(host, domain) && pattern.test(p));
  }

  global.LangslyHosts = Object.freeze({
    normalizeHost, hostMatchesDomain, matchesAnyDomain, isSensitiveHost, isSensitivePage, SENSITIVE_DOMAINS,
  });
})(globalThis);
