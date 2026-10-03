/**
 * Pages publiques servies à la racine du domaine (hors préfixe /api) :
 * présentation de Voyagooo (projet partenaire Travelpayouts) et confidentialité.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const shell = (title: string, description: string, body: string) => `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta name="theme-color" content="#0F1117">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>✈️</text></svg>">
<style>
:root{--bg:#0F1117;--surface:#1A1D27;--border:#2A2D3A;--text:#fff;--muted:#8A8A9B;--green:#58CC02;--green-dark:#4CAF00;--blue:#1CB0F6;--yellow:#FFC800}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;line-height:1.55}
a{color:var(--green)}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px}
header{display:flex;align-items:center;justify-content:space-between;padding:20px 0}
.logo{font-weight:900;font-size:22px;letter-spacing:-.5px;color:var(--text);text-decoration:none}
.logo span{color:var(--green)}
nav a{color:var(--muted);text-decoration:none;margin-left:18px;font-weight:600;font-size:14px}
.hero{padding:56px 0 40px;text-align:center}
.hero h1{font-size:clamp(32px,6vw,56px);line-height:1.08;margin:0 0 16px;font-weight:900;letter-spacing:-1px}
.hero h1 em{font-style:normal;color:var(--green)}
.hero p{color:var(--muted);font-size:18px;max-width:640px;margin:0 auto 28px}
.btn{display:inline-block;background:var(--green);color:#fff;font-weight:800;padding:14px 26px;border-radius:16px;text-decoration:none;box-shadow:0 4px 0 var(--green-dark)}
.badge{display:inline-block;margin:0 6px 10px;padding:6px 12px;border:1px solid var(--border);border-radius:999px;color:var(--muted);font-size:13px;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;margin:40px 0}
.card{background:var(--surface);border:1px solid var(--border);border-radius:22px;padding:20px}
.card .ico{font-size:30px}
.card h3{margin:8px 0 6px;font-size:17px}
.card p{margin:0;color:var(--muted);font-size:14px}
section h2{font-size:26px;margin:48px 0 10px;text-align:center}
.partners{text-align:center;color:var(--muted);font-size:14px;max-width:720px;margin:0 auto}
@media (max-width:480px){nav a:first-child{display:none}nav a{margin-left:0}}
footer{border-top:1px solid var(--border);margin-top:56px;padding:24px 0 40px;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between}
.doc{max-width:760px;margin:0 auto;padding:24px 0}
.doc h1{font-size:30px}
.doc h2{font-size:19px;margin-top:28px}
.doc p,.doc li{color:#d6d6de}
</style>
</head>
<body>
<div class="wrap">
<header>
  <a class="logo" href="/">Voya<span>gooo</span></a>
  <nav><a href="/#fonctionnalites">Fonctionnalités</a><a href="/confidentialite">Confidentialité</a></nav>
</header>
${body}
<footer>
  <span>© ${new Date().getFullYear()} Voyagooo — voyager malin, jour après jour.</span>
  <span><a href="/confidentialite">Confidentialité</a> · <a href="/#partenaires">Partenaires</a></span>
</footer>
</div>
</body>
</html>`;

export function landingPage(contactEmail?: string) {
  const features = [
    ['🗺️', 'Itinéraire IA jour par jour', 'Dis où tu pars, ton rythme et tes envies : Voyagooo compose un programme sur carte, étape par étape, avec météo et trajets.'],
    ['💰', 'Réservations & Budget', 'Hébergements par quartier, vols aux vrais prix, billets et transports, filtrés selon ton budget et la taille de ton groupe.'],
    ['✈️', 'Vols au meilleur prix', 'Les tarifs aller-retour relevés pour tes dates, et les jours où le même séjour coûte moins cher.'],
    ['🧳', 'Ma valise', 'Une liste sur mesure selon la destination, la météo, la durée et qui voyage, avec un dernier check avant le départ.'],
    ['💎', 'Pépites & gamification', 'Découvre des lieux secrets sur place, gagne de l\'XP, des badges et monte de niveau.'],
    ['👥', 'Tribus', 'Prépare un voyage à plusieurs : votes, cercles privés, conseils de la communauté.'],
    ['📖', 'Journal de voyage', 'À la fin du séjour, ton voyage rejoint ton journal avec son bilan et des idées pour la suite.'],
    ['🔔', 'Rappels malins', 'La veille du départ et chaque soir sur place, à l\'heure locale de chaque voyageur.'],
  ];
  const body = `
<section class="hero">
  <div><span class="badge">🌍 Planificateur de voyage</span><span class="badge">🤖 IA</span><span class="badge">🎮 Gamifié</span></div>
  <h1>Ton voyage, <em>planifié jour par jour</em><br>et dans ton budget.</h1>
  <p>Voyagooo est l'application qui crée ton itinéraire, trouve où dormir, compare les vols et suit tes dépenses, du premier jour au retour.</p>
  <a class="btn" href="#fonctionnalites">Découvrir l'app</a>
</section>
<section id="fonctionnalites">
  <h2>Tout ton voyage dans une seule app</h2>
  <div class="grid">
    ${features.map(([i, t, d]) => `<div class="card"><div class="ico">${i}</div><h3>${esc(t)}</h3><p>${esc(d)}</p></div>`).join('\n    ')}
  </div>
</section>
<section id="partenaires">
  <h2>Nos partenaires</h2>
  <p class="partners">Pour réserver, Voyagooo propose des liens vers des services de voyage reconnus (vols, hébergements, activités, transports), notamment via le réseau Travelpayouts (Aviasales, Booking.com, GetYourGuide…). Les prix affichés sont indicatifs et confirmés chez le partenaire. Voyagooo peut percevoir une commission sur les réservations effectuées via ces liens, sans aucun surcoût pour toi.</p>
  ${contactEmail ? `<p class="partners" style="margin-top:14px">Contact : <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a></p>` : ''}
</section>`;
  return shell(
    'Voyagooo — ton voyage planifié jour par jour, dans ton budget',
    'Itinéraire IA, réservations selon ton budget, vols aux vrais prix, valise sur mesure et journal de voyage.',
    body,
  );
}

export function privacyPage(contactEmail?: string) {
  const body = `
<article class="doc">
  <h1>Politique de confidentialité</h1>
  <p>Cette page explique quelles données l'application Voyagooo utilise et pourquoi.</p>
  <h2>Données utilisées</h2>
  <ul>
    <li><strong>Compte</strong> : adresse e-mail, nom d'utilisateur, photo de profil et informations de profil que tu choisis de renseigner (ville, préférences de voyage).</li>
    <li><strong>Voyages</strong> : destinations, dates, budget, composition du groupe, itinéraires, valise et dépenses que tu enregistres.</li>
    <li><strong>Localisation</strong> : uniquement pendant l'utilisation de la carte, pour te guider et détecter les pépites à proximité.</li>
    <li><strong>Notifications</strong> : un identifiant d'appareil pour t'envoyer les rappels que tu as activés.</li>
  </ul>
  <h2>Utilisation</h2>
  <p>Ces données servent à faire fonctionner l'application : créer tes itinéraires, estimer ton budget, afficher des propositions de réservation et t'envoyer des rappels. Elles ne sont pas vendues.</p>
  <h2>Partenaires de réservation</h2>
  <p>Quand tu ouvres un lien de réservation, tu es dirigé vers le site du partenaire (par exemple Aviasales, Booking.com ou GetYourGuide), soumis à sa propre politique de confidentialité. Ces liens peuvent contenir un identifiant de suivi affilié, sans transmission de tes données personnelles.</p>
  <h2>Tes droits</h2>
  <p>Tu peux consulter, modifier ou supprimer ton compte et tes voyages depuis l'application${contactEmail ? `, ou nous écrire à <a href="mailto:${esc(contactEmail)}">${esc(contactEmail)}</a>` : ''}.</p>
</article>`;
  return shell('Confidentialité — Voyagooo', 'Politique de confidentialité de l’application Voyagooo.', body);
}
