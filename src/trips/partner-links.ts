/**
 * Liens pré-remplis vers les partenaires de réservation (Travelpayouts et autres).
 * Chaque lien est ensuite converti en lien affilié quand la marque a validé le projet ;
 * sinon il reste un lien normal, qui fonctionne tout autant.
 */

export interface PartnerChoice {
  partner: string;
  label: string;
  url: string;
  note?: string;
}

interface StaySearch {
  where: string;
  checkin: string | null;
  checkout: string | null;
  adults: number;
  kids: number[];
  currency: string;
  maxPerNight: number;
}

const q = (v: string) => encodeURIComponent(v);
const rooms = (adults: number) => Math.max(1, Math.ceil(adults / 2));

/** Hébergements : Booking.com, Airbnb, Agoda, Trip.com, Expedia */
export function lodgingChoices(s: StaySearch, bookingUrl: string, airbnbUrl: string): PartnerChoice[] {
  const agoda = new URLSearchParams({
    textToSearch: s.where,
    rooms: String(rooms(s.adults)),
    adults: String(s.adults),
    children: String(s.kids.length),
    priceCur: s.currency,
  });
  if (s.kids.length) agoda.set('childAges', s.kids.join(','));
  if (s.checkin) agoda.set('checkIn', s.checkin);
  if (s.checkout) agoda.set('checkOut', s.checkout);

  const trip = new URLSearchParams({
    keyword: s.where,
    adult: String(s.adults),
    children: String(s.kids.length),
    crn: String(rooms(s.adults)),
    curr: s.currency,
  });
  if (s.kids.length) trip.set('ages', s.kids.join(','));
  if (s.checkin) trip.set('checkin', s.checkin.replace(/-/g, '/'));
  if (s.checkout) trip.set('checkout', s.checkout.replace(/-/g, '/'));

  const expedia = new URLSearchParams({ destination: s.where, adults: String(s.adults) });
  if (s.kids.length) expedia.set('children', s.kids.map((a) => `1_${a}`).join(','));
  if (s.checkin) expedia.set('startDate', s.checkin);
  if (s.checkout) expedia.set('endDate', s.checkout);

  return [
    { partner: 'booking', label: 'Booking.com', url: bookingUrl },
    { partner: 'airbnb', label: 'Airbnb', url: airbnbUrl },
    { partner: 'agoda', label: 'Agoda', url: `https://www.agoda.com/fr-fr/search?${agoda}` },
    { partner: 'trip', label: 'Trip.com', url: `https://fr.trip.com/hotels/list?${trip}` },
    { partner: 'expedia', label: 'Expedia', url: `https://www.expedia.fr/Hotel-Search?${expedia}` },
  ];
}

/** Billets et visites : Tiqets, Klook, GetYourGuide, Viator */
export function activityChoices(name: string, city: string): PartnerChoice[] {
  const term = `${name} ${city}`;
  return [
    { partner: 'tiqets', label: 'Tiqets', url: `https://www.tiqets.com/fr/search?q=${q(term)}` },
    { partner: 'klook', label: 'Klook', url: `https://www.klook.com/fr/search/result/?query=${q(term)}` },
    { partner: 'getyourguide', label: 'GetYourGuide', url: `https://www.getyourguide.fr/s/?q=${q(term)}` },
    { partner: 'viator', label: 'Viator', url: `https://www.viator.com/fr-FR/searchResults/all?text=${q(term)}` },
  ];
}

/** Transfert aéroport ↔ hébergement à prix fixe */
export function transferChoices(): PartnerChoice[] {
  return [
    { partner: 'kiwitaxi', label: 'Kiwitaxi', url: 'https://kiwitaxi.com/fr', note: 'Chauffeur privé, prix fixe' },
    { partner: 'welcomepickups', label: 'Welcome Pickups', url: 'https://www.welcomepickups.com/fr/', note: 'Accueil pancarte à l’arrivée' },
    { partner: 'gettransfer', label: 'GetTransfer', url: 'https://gettransfer.com/fr', note: 'Compare les offres de chauffeurs' },
  ];
}

/** Location de voiture */
export function carChoices(): PartnerChoice[] {
  return [
    { partner: 'localrent', label: 'Localrent', url: 'https://localrent.com/fr/', note: 'Loueurs locaux, sans franchise cachée' },
    { partner: 'getrentacar', label: 'GetRentacar', url: 'https://getrentacar.com/fr/', note: 'Voitures de particuliers et pros' },
    { partner: 'discovercars', label: 'DiscoverCars', url: 'https://www.discovercars.com/fr', note: 'Comparateur de loueurs' },
  ];
}

/** eSIM data pour le pays de destination (Airalo) */
export function esimChoices(countryCode?: string | null): PartnerChoice[] {
  let slug = '';
  try {
    if (countryCode && /^[A-Za-z]{2}$/.test(countryCode)) {
      const name = new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode.toUpperCase()) || '';
      slug = name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    }
  } catch {
    slug = '';
  }
  return [
    {
      partner: 'airalo',
      label: 'Airalo',
      url: slug ? `https://www.airalo.com/fr/${slug}-esim` : 'https://www.airalo.com/fr',
      note: 'Internet dès l’atterrissage',
    },
  ];
}

/** Marques à convertir via l'API Travelpayouts (les autres liens restent tels quels) */
export const AFFILIATE_PARTNERS = new Set([
  'booking',
  'agoda',
  'trip',
  'expedia',
  'tiqets',
  'klook',
  'getyourguide',
  'viator',
  'kiwitaxi',
  'welcomepickups',
  'gettransfer',
  'localrent',
  'getrentacar',
  'discovercars',
  'airalo',
]);
