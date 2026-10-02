/* eslint-disable no-console */
/**
 * Diagnostic des e-mails Resend : vérifie la clé, le domaine d'expédition et envoie un e-mail de test.
 *
 *   npm run mail:test -- ton.adresse@exemple.com
 *   (ou : node scripts/test-mail.js ton.adresse@exemple.com)
 *
 * Lit RESEND_API_KEY et MAIL_FROM dans .env (ou l'environnement), comme le backend.
 */
const fs = require('fs');
const path = require('path');
const { Resend } = require('resend');

// Chargement du .env sans dépendance supplémentaire (les variables déjà définies priment)
const envPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const ok = (msg) => console.log(`  ✅ ${msg}`);
const ko = (msg) => console.log(`  ❌ ${msg}`);
const info = (msg) => console.log(`  ℹ️  ${msg}`);

function hintFor(message = '') {
  const m = message.toLowerCase();
  if (m.includes('api key is invalid') || m.includes('invalid api key') || m.includes('unauthorized'))
    return 'Clé RESEND_API_KEY invalide : recopie-la depuis resend.com → API Keys (sans espace ni guillemet).';
  if (m.includes('not verified') || m.includes('domain'))
    return "Le domaine de MAIL_FROM n'est pas vérifié : resend.com → Domains, ajoute les enregistrements DNS (SPF, DKIM) puis « Verify ».";
  if (m.includes('only send testing emails') || m.includes('own email'))
    return "Sans domaine vérifié, Resend n'envoie qu'à l'adresse du compte Resend : vérifie le domaine ou teste avec cette adresse.";
  if (m.includes('restricted') || m.includes('permission'))
    return "La clé n'a pas le droit d'envoyer : crée une clé « Full access » ou « Sending access ».";
  if (m.includes('rate')) return 'Limite de débit Resend atteinte : réessaie dans une minute.';
  return 'Consulte resend.com → Emails / Logs pour le détail.';
}

(async () => {
  const to = process.argv[2];
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'Voyagooo <noreply@voyagooo.com>';
  console.log('\n📬 Diagnostic des e-mails Voyagooo (Resend)\n');

  // 1. Configuration
  if (!key) {
    ko('RESEND_API_KEY absente : le backend écrit les codes dans les logs au lieu de les envoyer.');
    process.exit(1);
  }
  ok(`RESEND_API_KEY présente (${key.slice(0, 5)}…${key.slice(-4)})`);
  if (!key.startsWith('re_')) ko('La clé devrait commencer par « re_ » : vérifie la valeur copiée.');
  const fromDomain = (from.match(/@([^>\s]+)/) || [])[1];
  info(`Expéditeur (MAIL_FROM) : ${from}`);

  const resend = new Resend(key);

  // 2. Domaine d'expédition
  const domains = await resend.domains.list();
  if (domains.error) {
    ko(`Lecture des domaines impossible : ${domains.error.message}`);
    info(hintFor(domains.error.message));
  } else {
    // Selon la version de l'API, la liste est directement dans data ou dans data.data
    const list = Array.isArray(domains.data) ? domains.data : (domains.data && domains.data.data) || [];
    if (!list.length) ko('Aucun domaine dans ce compte Resend.');
    for (const d of list) console.log(`  • ${d.name} : ${d.status}${d.status === 'verified' ? ' ✅' : ' ⚠️'}`);
    const match = list.find((d) => d.name === fromDomain || (fromDomain || '').endsWith(`.${d.name}`));
    if (fromDomain === 'resend.dev') {
      info("Adresse de test resend.dev : l'envoi ne marche que vers l'adresse de ton compte Resend.");
    } else if (!match) {
      ko(`Le domaine « ${fromDomain} » de MAIL_FROM n'est pas dans ton compte Resend : ajoute-le (Domains) ou change MAIL_FROM.`);
    } else if (match.status !== 'verified') {
      ko(`Le domaine « ${match.name} » est « ${match.status} » : termine la vérification DNS dans Resend.`);
    } else {
      ok(`Domaine « ${match.name} » vérifié`);
    }
  }

  // 3. Envoi réel
  if (!to) {
    info('Ajoute une adresse pour un envoi réel : npm run mail:test -- ton.adresse@exemple.com\n');
    return;
  }
  const { data, error } = await resend.emails.send({
    from,
    to,
    subject: '✅ Test d’envoi Voyagooo',
    html: '<div style="font-family:sans-serif"><h2>🦜 Voyagooo</h2><p>Si tu lis ceci, les e-mails Resend fonctionnent.</p></div>',
    text: 'Voyagooo : si tu lis ceci, les e-mails Resend fonctionnent.',
  });
  if (error) {
    ko(`Envoi refusé par Resend : ${error.message}`);
    info(hintFor(error.message));
    process.exit(1);
  }
  ok(`E-mail envoyé à ${to} (id ${data && data.id}). Pense à regarder dans les spams.\n`);
})().catch((err) => {
  ko(`Erreur inattendue : ${err.message}`);
  process.exit(1);
});
