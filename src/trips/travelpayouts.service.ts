import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/** Offre de vol réelle (cache Aviasales, recherches des dernières 48 h) */
export interface FlightOffer {
  price: number;
  airline: string | null;
  airline_code: string | null;
  departure_at: string | null;
  return_at: string | null;
  transfers: number;
  return_transfers: number | null;
  duration_to: number | null;
  duration_back: number | null;
  link: string;
}

export interface FlightQuote {
  origin: { code: string; name: string };
  destination: { code: string; name: string };
  currency: string;
  /** Offres pour les dates exactes du voyage (vide si rien en cache) */
  offers: FlightOffer[];
  /** Mêmes durées de séjour, d'autres jours du mois : moins cher */
  cheaper_dates: FlightOffer[];
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
  // Vols
  // ---------------------------------------------------------------------------

  /**
   * Prix réels aller-retour : offres aux dates du voyage, et jours du même mois
   * où la même durée de séjour coûte moins cher. Null si rien d'exploitable.
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
    const searchLink = this.searchLink(origin.code, destination.code, o.departure, o.returnDate, o.adults, o.kids);

    try {
      const [exact, month, names] = await Promise.all([
        o.departure ? this.prices(origin.code, destination.code, o.departure, o.returnDate, currency, 5) : Promise.resolve([]),
        this.prices(
          origin.code,
          destination.code,
          o.departure ? o.departure.slice(0, 7) : null,
          o.returnDate ? o.returnDate.slice(0, 7) : null,
          currency,
          60,
        ),
        this.airlineNames(),
      ]);

      const toOffer = (r: any): FlightOffer => ({
        price: Math.round(Number(r.price) || 0),
        airline: names[r.airline] || r.airline || null,
        airline_code: r.airline || null,
        departure_at: r.departure_at || null,
        return_at: r.return_at || null,
        transfers: Number(r.transfers ?? 0),
        return_transfers: r.return_transfers != null ? Number(r.return_transfers) : null,
        duration_to: r.duration_to ?? null,
        duration_back: r.duration_back ?? null,
        link: this.withMarker(r.link ? `https://www.aviasales.com${r.link}` : searchLink),
      });

      const offers = exact.map(toOffer).filter((x) => x.price > 0);
      // Même durée de séjour (± 1 jour) à d'autres dates, nettement moins cher
      const nights = o.departure && o.returnDate ? this.daysBetween(o.departure, o.returnDate) : null;
      const reference = offers[0]?.price ?? null;
      const cheaper = month
        .map(toOffer)
        .filter((x) => x.price > 0 && x.departure_at && x.return_at)
        .filter((x) => nights == null || Math.abs(this.daysBetween(x.departure_at!, x.return_at!) - nights) <= 1)
        .filter((x) => !o.departure || x.departure_at!.slice(0, 10) !== o.departure)
        .filter((x) => reference == null || x.price <= reference * 0.9)
        .sort((a, b) => a.price - b.price);
      // Une seule offre par jour de départ
      const seen = new Set<string>();
      const cheaperDates = cheaper.filter((x) => {
        const d = x.departure_at!.slice(0, 10);
        if (seen.has(d)) return false;
        seen.add(d);
        return true;
      });

      if (!offers.length && !cheaperDates.length) return { origin, destination, currency: o.currency, offers: [], cheaper_dates: [], search_link: searchLink };
      return { origin, destination, currency: o.currency, offers: offers.slice(0, 3), cheaper_dates: cheaperDates.slice(0, 3), search_link: searchLink };
    } catch (e: any) {
      this.logger.warn(`Prix des vols indisponibles ${origin.code}→${destination.code} : ${e.message}`);
      return { origin, destination, currency: o.currency, offers: [], cheaper_dates: [], search_link: searchLink };
    }
  }

  private prices(origin: string, destination: string, departure: string | null, back: string | null, currency: string, limit: number) {
    const key = `prices:${origin}:${destination}:${departure}:${back}:${currency}:${limit}`;
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
          market: 'fr',
          token: this.token,
        },
        timeout: 6000,
      });
      return Array.isArray(res.data?.data) ? res.data.data : [];
    });
  }

  /** Recherche Aviasales pré-remplie : PAR1011LIS14112 (villes, jours/mois, passagers) */
  private searchLink(from: string, to: string, out: string | null, back: string | null, adults: number, kids: number[]) {
    if (!out) return this.withMarker(`https://www.aviasales.com/?origin_iata=${from}&destination_iata=${to}`);
    const ddmm = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}`;
    const children = kids.filter((a) => a >= 2).length;
    const infants = kids.filter((a) => a < 2).length;
    const pax = `${Math.min(9, adults)}${children || infants ? Math.min(9, children) : ''}${infants ? Math.min(9, infants) : ''}`;
    return this.withMarker(`https://www.aviasales.com/search/${from}${ddmm(out)}${to}${back ? ddmm(back) : ''}${pax}`);
  }

  private withMarker(url: string) {
    if (!this.marker) return url;
    return `${url}${url.includes('?') ? '&' : '?'}marker=${encodeURIComponent(this.marker)}`;
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
