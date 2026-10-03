import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Offre de vol réelle (cache Aviasales des recherches récentes), prix par adulte aller-retour */
export interface FlightOffer {
  price: number;
  airline: string | null;
  airline_code: string | null;
  origin?: string;
  destination?: string;
  departure_at: string | null;
  return_at: string | null;
  transfers: number;
  return_transfers: number | null;
  duration_to: number | null;
  duration_back: number | null;
  /** Durée totale (vols + escales) en minutes, quand elle est connue */
  duration: number | null;
  link: string;
}

export type FlightHighlight = 'cheapest' | 'direct' | 'fastest' | 'best';

export interface FlightQuote {
  origin: { code: string; name: string };
  destination: { code: string; name: string };
  currency: string;
  /** Offres pour les dates exactes du voyage, de la moins chère à la plus chère */
  offers: FlightOffer[];
  /** Repères du comparatif : la moins chère, la moins chère en direct, la plus rapide, le meilleur rapport */
  highlights: { kind: FlightHighlight; offer: FlightOffer }[];
  /** Même durée de séjour, d'autres jours du mois : moins cher */
  cheaper_dates: FlightOffer[];
  /** ± 3 jours autour du départ (grille Aviasales) : le prix de chaque jour */
  flexible: { departure: string; return: string | null; price: number; link: string }[];
  /** Aéroports ou villes proches, moins chers */
  nearby: { origin: string; destination: string; price: number; departure: string | null; return: string | null; transfers: number; distance_km: number | null; link: string }[];
  /** Le meilleur prix comparé aux prix du mois sur cette ligne */
  insight: { median: number; min: number; verdict: 'good' | 'average' | 'high' } | null;
  search_link: string;
}

const PRICE_TTL_MS = 6 * 3600_000;
const LINK_TTL_MS = 24 * 3600_000;

/**
 * Travelpayouts : vrais prix des vols (Aviasales Data API), codes IATA des villes
 * et liens partenaires affiliés. Tout est mis en cache et chaque appel a un repli :
 * sans jeton ou si l'API ne répond pas, l'app garde ses liens et estimations habituels.
 */
@Injectable()
export class TravelpayoutsService {
  private readonly logger = new Logger(TravelpayoutsService.name);
  private readonly cache = new Map<string, { at: number; ttl: number; value: any }>();
  private readonly inflight = new Map<string, Promise<any>>();
  private airlines: Record<string, string> | null = null;

  constructor(private readonly config: ConfigService) {}

  private get token() {
    return this.config.get<string>('TRAVELPAYOUTS_TOKEN') || '';
  }

  get marker() {
    return this.config.get<string>('TRAVELPAYOUTS_MARKER') || '';
  }

  get enabled() {
    return !!this.token;
  }

  /** Mémoïsation avec durée de vie et dédoublonnage des appels simultanés */
  private async cached<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
    if (this.inflight.has(key)) return this.inflight.get(key) as Promise<T>;
    const p = load()
      .then((value) => {
        this.cache.set(key, { at: Date.now(), ttl, value });
        if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value as string);
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ---------------------------------------------------------------------------
  // Villes → code IATA
  // ---------------------------------------------------------------------------

  async cityCode(term?: string | null): Promise<{ code: string; name: string } | null> {
    const q = (term || '').trim();
    if (!q) return null;
    return this.cached(`iata:${q.toLowerCase()}`, 30 * 24 * 3600_000, async () => {
      try {
        const res = await axios.get('https://autocomplete.travelpayouts.com/places2', {
          params: { term: q, locale: 'fr', types: ['city', 'airport'] },
          timeout: 4000,
        });
        const place = (res.data || []).find((p: any) => p?.code && (p.type === 'city' || p.city_code));
        if (!place) return null;
        const code = place.type === 'airport' && place.city_code ? place.city_code : place.code;
        return { code, name: place.type === 'airport' ? place.city_name || place.name : place.name };
      } catch (e: any) {
        this.logger.warn(`IATA introuvable pour « ${q} » : ${e.message}`);
        return null;
      }
    });
  }

  private async airlineNames(): Promise<Record<string, string>> {
    if (this.airlines) return this.airlines;
    return this.cached('airlines', 7 * 24 * 3600_000, async () => {
      try {
        const res = await axios.get('https://api.travelpayouts.com/data/fr/airlines.json', { timeout: 6000 });
        const map: Record<string, string> = {};
        for (const a of res.data || []) if (a?.code) map[a.code] = a.name || a.name_translations?.en || a.code;
        this.airlines = map;
        return map;
      } catch {
        return {};
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Vols : comparatif (Aviasales Data API)
  // ---------------------------------------------------------------------------

  /** Marché des prix Aviasales (le cache diffère d'un marché à l'autre) */
  private get market() {
    return (this.config.get<string>('TRAVELPAYOUTS_MARKET') || 'fr').toLowerCase();
  }

  /**
   * Comparatif des vols aller-retour pour le groupe : offres aux dates du voyage et leurs repères
   * (moins cher, direct, plus rapide, meilleur rapport), jours voisins, aéroports proches et
   * verdict sur le prix. Null sans jeton ou si les villes sont inconnues.
   */
  async flightQuote(o: {
    from?: string | null;
    to: string;
    departure: string | null;
    returnDate: string | null;
    currency: string;
    adults: number;
    kids: number[];
  }): Promise<FlightQuote | null> {
    if (!this.enabled) return null;
    const [origin, destination] = await Promise.all([this.cityCode(o.from), this.cityCode(o.to)]);
    if (!origin || !destination || origin.code === destination.code) return null;

    const currency = o.currency.toLowerCase();
    const pax = this.paxBlock(o.adults, o.kids);
    const searchLink = this.searchLink(origin.code, destination.code, o.departure, o.returnDate, pax);
    const empty: FlightQuote = {
      origin,
      destination,
      currency: o.currency,
      offers: [],
      highlights: [],
      cheaper_dates: [],
      flexible: [],
      nearby: [],
      insight: null,
      search_link: searchLink,
    };

    try {
      const month = (d: string | null) => (d ? d.slice(0, 7) : null);
      const [exact, monthly, week, near, names] = await Promise.all([
        o.departure
          ? this.safe(this.prices(origin.code, destination.code, o.departure, o.returnDate, currency, 30))
          : Promise.resolve([]),
        this.safe(this.prices(origin.code, destination.code, month(o.departure), month(o.returnDate), currency, 100)),
        o.departure ? this.safe(this.weekMatrix(origin.code, destination.code, o.departure, o.returnDate, currency)) : Promise.resolve([]),
        this.safe(this.nearestPlaces(origin.code, destination.code, month(o.departure), month(o.returnDate), currency)),
        this.airlineNames(),
      ]);

      const toOffer = (r: any): FlightOffer => ({
        price: Math.round(Number(r.price) || 0),
        airline: names[r.airline] || r.airline || null,
        airline_code: r.airline || null,
        origin: r.origin,
        destination: r.destination,
        departure_at: r.departure_at || null,
        return_at: r.return_at || null,
        transfers: Number(r.transfers ?? 0),
        return_transfers: r.return_transfers != null ? Number(r.return_transfers) : null,
        duration_to: r.duration_to ?? null,
        duration_back: r.duration_back ?? null,
        duration: r.duration ?? (r.duration_to != null ? r.duration_to + (r.duration_back ?? 0) : null),
        link: this.offerLink(r.link, pax, searchLink),
      });

      const offers = exact.map(toOffer).filter((x) => x.price > 0).sort((a, b) => a.price - b.price);
      const highlights = this.highlights(offers);
      const reference = offers[0]?.price ?? null;

      // Même durée de séjour (± 1 jour) à d'autres dates du mois, nettement moins cher
      const nights = o.departure && o.returnDate ? this.daysBetween(o.departure, o.returnDate) : null;
      const seen = new Set<string>();
      const cheaperDates = monthly
        .map(toOffer)
        .filter((x) => x.price > 0 && x.departure_at && x.return_at)
        .filter((x) => nights == null || Math.abs(this.daysBetween(x.departure_at!, x.return_at!) - nights) <= 1)
        .filter((x) => !o.departure || x.departure_at!.slice(0, 10) !== o.departure)
        .filter((x) => reference == null || x.price <= reference * 0.9)
        .sort((a, b) => a.price - b.price)
        .filter((x) => {
          const d = x.departure_at!.slice(0, 10);
          if (seen.has(d)) return false;
          seen.add(d);
          return true;
        })
        .slice(0, 3);

      // ± 3 jours : meilleur prix par jour de départ, durée de séjour conservée
      const byDay = new Map<string, { departure: string; return: string | null; price: number; link: string }>();
      for (const r of week) {
        const dep = String(r.depart_date || '').slice(0, 10);
        const ret = r.return_date ? String(r.return_date).slice(0, 10) : null;
        const price = Math.round(Number(r.value) || 0);
        if (!dep || !price) continue;
        if (nights != null && ret && Math.abs(this.daysBetween(dep, ret) - nights) > 1) continue;
        const prev = byDay.get(dep);
        if (!prev || price < prev.price) {
          byDay.set(dep, { departure: dep, return: ret, price, link: this.searchLink(origin.code, destination.code, dep, ret, pax) });
        }
      }
      const flexible = [...byDay.values()].sort((a, b) => a.departure.localeCompare(b.departure)).slice(0, 7);

      // Aéroports / villes proches moins chers (autre aéroport de départ ou d'arrivée)
      const nearby = near
        .map((r: any) => ({
          origin: String(r.origin || ''),
          destination: String(r.destination || ''),
          price: Math.round(Number(r.value) || 0),
          departure: r.depart_date ? String(r.depart_date).slice(0, 10) : null,
          return: r.return_date ? String(r.return_date).slice(0, 10) : null,
          transfers: Number(r.number_of_changes ?? 0),
          distance_km: r.distance != null ? Number(r.distance) : null,
        }))
        .filter((r) => r.price > 0 && r.origin && r.destination)
        .filter((r) => !(r.origin === origin.code && r.destination === destination.code))
        .filter((r) => reference == null || r.price <= reference * 0.85)
        .sort((a, b) => a.price - b.price)
        .slice(0, 3)
        .map((r) => ({ ...r, link: this.searchLink(r.origin, r.destination, r.departure, r.return, pax) }));

      // Verdict : le meilleur prix trouvé face à la médiane du mois
      const monthPrices = monthly.map((r: any) => Number(r.price) || 0).filter((x: number) => x > 0).sort((a: number, b: number) => a - b);
      let insight: FlightQuote['insight'] = null;
      if (reference != null && monthPrices.length >= 5) {
        const median = monthPrices[Math.floor(monthPrices.length / 2)];
        insight = {
          median: Math.round(median),
          min: Math.round(monthPrices[0]),
          verdict: reference <= median * 0.92 ? 'good' : reference >= median * 1.12 ? 'high' : 'average',
        };
      }

      return {
        ...empty,
        offers: offers.slice(0, 5),
        highlights,
        cheaper_dates: cheaperDates,
        flexible,
        nearby,
        insight,
      };
    } catch (e: any) {
      this.logger.warn(`Prix des vols indisponibles ${origin.code}→${destination.code} : ${e.message}`);
      return empty;
    }
  }

  /** Repères du comparatif, sans doublon : une même offre peut cumuler plusieurs titres */
  private highlights(offers: FlightOffer[]): { kind: FlightHighlight; offer: FlightOffer }[] {
    if (!offers.length) return [];
    const out: { kind: FlightHighlight; offer: FlightOffer }[] = [{ kind: 'cheapest', offer: offers[0] }];
    const direct = offers.find((x) => x.transfers === 0 && (x.return_transfers ?? 0) === 0);
    if (direct) out.push({ kind: 'direct', offer: direct });
    const timed = offers.filter((x) => x.duration != null);
    if (timed.length) {
      const fastest = [...timed].sort((a, b) => a.duration! - b.duration!)[0];
      out.push({ kind: 'fastest', offer: fastest });
      // Meilleur rapport : chaque heure de trajet en plus « coûte » 4 % du prix le plus bas
      const base = offers[0].price;
      const best = [...timed].sort(
        (a, b) => a.price + (a.duration! / 60) * base * 0.04 - (b.price + (b.duration! / 60) * base * 0.04),
      )[0];
      out.push({ kind: 'best', offer: best });
    }
    return out;
  }

  private async safe<T>(p: Promise<T[]>): Promise<T[]> {
    try {
      return await p;
    } catch (e: any) {
      this.logger.warn(`Aviasales : ${e.response?.status || ''} ${e.message}`);
      return [];
    }
  }

  private prices(origin: string, destination: string, departure: string | null, back: string | null, currency: string, limit: number) {
    const key = `prices:${this.market}:${origin}:${destination}:${departure}:${back}:${currency}:${limit}`;
    return this.cached<any[]>(key, PRICE_TTL_MS, async () => {
      const res = await axios.get('https://api.travelpayouts.com/aviasales/v3/prices_for_dates', {
        params: {
          origin,
          destination,
          ...(departure ? { departure_at: departure } : {}),
          ...(back ? { return_at: back } : {}),
          one_way: false,
          unique: false,
          sorting: 'price',
          direct: false,
          currency,
          limit,
          page: 1,
          market: this.market,
          token: this.token,
        },
        timeout: 6000,
      });
      return Array.isArray(res.data?.data) ? res.data.data : [];
    });
  }

  /** Grille ± 3 jours autour des dates (v2/prices/week-matrix) */
  private weekMatrix(origin: string, destination: string, departure: string, back: string | null, currency: string) {
    const key = `week:${this.market}:${origin}:${destination}:${departure}:${back}:${currency}`;
    return this.cached<any[]>(key, PRICE_TTL_MS, async () => {
      const res = await axios.get('https://api.travelpayouts.com/v2/prices/week-matrix', {
        params: {
          origin,
          destination,
          depart_date: departure,
          ...(back ? { return_date: back } : {}),
          currency,
          market: this.market,
          show_to_affiliates: true,
          token: this.token,
        },
        timeout: 6000,
      });
      return Array.isArray(res.data?.data) ? res.data.data : [];
    });
  }

  /** Prix entre les villes proches du départ et de l'arrivée (v2/prices/nearest-places-matrix) */
  private nearestPlaces(origin: string, destination: string, departure: string | null, back: string | null, currency: string) {
    const key = `near:${this.market}:${origin}:${destination}:${departure}:${back}:${currency}`;
    return this.cached<any[]>(key, PRICE_TTL_MS, async () => {
      const res = await axios.get('https://api.travelpayouts.com/v2/prices/nearest-places-matrix', {
        params: {
          origin,
          destination,
          ...(departure ? { depart_date: departure } : {}),
          ...(back ? { return_date: back } : {}),
          limit: 12,
          distance: 6,
          flexibility: 0,
          currency,
          market: this.market,
          show_to_affiliates: true,
          token: this.token,
        },
        timeout: 6000,
      });
      const prices = res.data?.prices;
      return Array.isArray(prices) ? prices : [];
    });
  }

  /** Bloc passagers Aviasales : adultes, enfants (2-11 ans), bébés, zéros finaux retirés (« 2 », « 21 », « 101 ») */
  private paxBlock(adults: number, kids: number[]) {
    const a = Math.max(1, Math.min(adults, 9));
    const children = Math.max(0, Math.min(kids.filter((x) => x >= 2).length, 8, 9 - a));
    const infants = Math.max(0, Math.min(kids.filter((x) => x < 2).length, 8, a));
    return `${a}${children}${infants}`.replace(/0+$/, '');
  }

  /** Lien d'une offre : l'API le donne pour 1 passager, on y met le groupe et le marker */
  private offerLink(fragment: string | undefined, pax: string, fallback: string) {
    if (!fragment) return fallback;
    const m = /^(\/search\/[A-Z]{3}\d{4}[A-Z]{3}(?:\d{4})?)(?:[a-z]?\d{1,3})(\?.*)?$/.exec(fragment);
    const path = m ? `${m[1]}${pax}${m[2] || ''}` : fragment;
    return this.withMarker(`https://www.aviasales.com${path}`);
  }

  /** Recherche Aviasales pré-remplie : PAR1011LIS14112 (villes, jours/mois, passagers) */
  private searchLink(from: string, to: string, out: string | null, back: string | null, pax: string) {
    if (!out) return this.withMarker(`https://www.aviasales.com/?origin_iata=${from}&destination_iata=${to}`);
    const ddmm = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}`;
    return this.withMarker(`https://www.aviasales.com/search/${from}${ddmm(out)}${to}${back ? ddmm(back) : ''}${pax}`);
  }

  private withMarker(url: string) {
    if (!this.marker) return url;
    const [path, query = ''] = url.split('?');
    const params = new URLSearchParams(query);
    params.set('marker', this.marker);
    return `${path}?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Liens partenaires affiliés
  // ---------------------------------------------------------------------------

  /**
   * Convertit des liens de marques partenaires en liens affiliés (10 par appel).
   * Nécessite TRAVELPAYOUTS_TRS (ID du projet) ; sinon, ou en cas d'échec, liens d'origine.
   */
  async affiliate(urls: string[]): Promise<Record<string, string>> {
    const trs = this.config.get<string>('TRAVELPAYOUTS_TRS');
    const out: Record<string, string> = {};
    const unique = [...new Set(urls.filter(Boolean))];
    if (!this.enabled || !trs || !this.marker) {
      for (const u of unique) out[u] = u;
      return out;
    }

    const missing: string[] = [];
    for (const u of unique) {
      const hit = this.cache.get(`link:${u}`);
      if (hit && Date.now() - hit.at < hit.ttl) out[u] = hit.value;
      else missing.push(u);
    }
    // Lots de 10 liens envoyés en parallèle (limite de l'API)
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += 10) batches.push(missing.slice(i, i + 10));
    await Promise.all(
      batches.map(async (batch) => {
        try {
          const res = await axios.post(
            'https://api.travelpayouts.com/links/v1/create',
            { trs: Number(trs) || trs, marker: Number(this.marker) || this.marker, shorten: false, links: batch.map((url) => ({ url })) },
            { headers: { 'X-Access-Token': this.token, 'Content-Type': 'application/json' }, timeout: 5000 },
          );
          const links: any[] = res.data?.result?.links || res.data?.links || [];
          batch.forEach((u, idx) => {
            const l = links.find((x) => x?.url === u) || links[idx];
            const partner = l && (!l.code || l.code === 'success') ? l.partner_url || l.short_url : null;
            out[u] = partner || u;
            // Marque pas encore validée : nouvel essai dans une heure
            this.cache.set(`link:${u}`, { at: Date.now(), ttl: partner ? LINK_TTL_MS : 3600_000, value: out[u] });
          });
        } catch (e: any) {
          this.logger.warn(`Liens partenaires non convertis : ${e.response?.data?.message || e.message}`);
          for (const u of batch) out[u] = u;
        }
      }),
    );
    return out;
  }

  private daysBetween(a: string, b: string) {
    return Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400_000);
  }
}
