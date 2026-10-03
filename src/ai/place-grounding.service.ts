import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import axios from 'axios';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { CatalogImage, CatalogImageDocument } from '../catalog/schemas/catalog-image.schema';
import { CatalogPlaceIndex, CatalogPlaceIndexDocument } from '../catalog/schemas/catalog-place-index.schema';

const UA = { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' };
/** Liste des lieux réels d'une destination : revue tous les 90 jours */
const INDEX_TTL_MS = 90 * 24 * 3600_000;
/** Lieux d'un voyage en ville (excursions comprises) : au plus 60 km du centre */
const CITY_MAX_KM = 60;
const STOPWORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'd', 'l', 'et', 'a', 'au', 'aux', 'en', 'the', 'of', 'and', 'at', 'on', 'in', 'el', 'al', 'di', 'da',
]);

export interface GroundedPlace {
  name: string;
  lat: number;
  lng: number;
  /** wikipedia | osm */
  source: string;
  /** catégorie OSM lisible (musée, parc, marché, restaurant…) */
  kind?: string;
  wiki?: { lang: string; title: string };
  /** lieu de restauration (créneau déjeuner) */
  food?: boolean;
}

export interface GroundingScope {
  destination: string;
  center: { lat: number; lng: number };
  /** Code pays ISO2 de la destination (vérification des voyages « pays ») */
  countryCode?: string | null;
  /** La destination est un pays entier (lieux dispersés) */
  isCountry: boolean;
}

export function placeNorm(v: string): string {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(v: string): string[] {
  return placeNorm(v)
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Ressemblance de deux noms (0 à 1) : mots en commun, inclusion de l'un dans l'autre */
export function nameSimilarity(a: string, b: string): number {
  const na = placeNorm(a);
  const nb = placeNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if ((na.length >= 5 && nb.includes(na)) || (nb.length >= 5 && na.includes(nb))) return 0.9;
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size) * (common / Math.max(ta.size, tb.size)) ** 0.25;
}

export function kmBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Petite file : au plus `n` appels réseau en même temps */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/**
 * Ancrage dans le réel : rien d'inventé dans un itinéraire.
 * 1. Avant l'IA : liste des lieux réels de la destination (Wikipédia + OpenStreetMap), gardée 90 jours.
 * 2. Après l'IA : chaque lieu est vérifié (liste, puis géocodage OpenStreetMap) et prend ses vraies
 *    coordonnées ; un lieu introuvable est retiré et remplacé par un lieu réel proche.
 * 3. Images : la photo de l'article Wikipédia du lieu, sinon une photo géolocalisée sur place ;
 *    jamais une image d'un autre lieu.
 */
@Injectable()
export class PlaceGroundingService {
  private readonly logger = new Logger(PlaceGroundingService.name);
  private readonly inflight = new Map<string, Promise<GroundedPlace[]>>();

  constructor(
    @Optional() @InjectModel(CatalogPlaceIndex.name, GLOBAL_DB_CONNECTION) private readonly indexModel?: Model<CatalogPlaceIndexDocument>,
    @Optional() @InjectModel(CatalogImage.name, GLOBAL_DB_CONNECTION) private readonly imageModel?: Model<CatalogImageDocument>,
  ) {}

  // ---------------------------------------------------------------------------
  // Portée de la destination
  // ---------------------------------------------------------------------------

  /** Ville ou pays ? Code pays ? (Photon / OpenStreetMap) */
  async scope(destination: string, center: { lat: number; lng: number }): Promise<GroundingScope> {
    try {
      const res = await axios.get('https://photon.komoot.io/api/', {
        params: { q: destination, limit: 1, lang: 'fr' },
        headers: UA,
        timeout: 5000,
      });
      const p = res.data?.features?.[0]?.properties;
      if (p) {
        return {
          destination,
          center,
          countryCode: p.countrycode ? String(p.countrycode).toUpperCase() : null,
          isCountry: p.type === 'country' || (p.osm_key === 'place' && p.osm_value === 'country'),
        };
      }
    } catch (err: any) {
      this.logger.warn(`Portée de ${destination} inconnue : ${err.message}`);
    }
    return { destination, center, countryCode: null, isCountry: false };
  }

  // ---------------------------------------------------------------------------
  // 1. Lieux réels de la destination (contexte donné à l'IA)
  // ---------------------------------------------------------------------------

  async candidates(scope: GroundingScope): Promise<GroundedPlace[]> {
    if (scope.isCountry) return [];
    const key = `${placeNorm(scope.destination)}|${scope.center.lat.toFixed(2)}|${scope.center.lng.toFixed(2)}`;
    if (this.indexModel) {
      try {
        const doc: any = await this.indexModel.findOne({ key }).lean().exec();
        if (doc && Date.now() - new Date(doc.fetched_at).getTime() < INDEX_TTL_MS && doc.places?.length) return doc.places;
      } catch {
        // base indisponible : on interroge les sources directement
      }
    }
    if (this.inflight.has(key)) return this.inflight.get(key)!;
    const job = (async () => {
      const [wikiFr, wikiEn, osm] = await Promise.all([
        this.wikiGeosearch('fr', scope.center),
        this.wikiGeosearch('en', scope.center),
        this.overpass(scope.center),
      ]);
      // Fusion : un même lieu (nom proche, à moins de 300 m) n'apparaît qu'une fois, lien Wikipédia gardé
      const merged: GroundedPlace[] = [];
      for (const p of [...osm, ...wikiFr, ...wikiEn]) {
        const twin = merged.find((m) => kmBetween(m, p) < 0.3 && nameSimilarity(m.name, p.name) >= 0.6);
        if (twin) {
          twin.wiki = twin.wiki || p.wiki;
          twin.kind = twin.kind || p.kind;
        } else {
          merged.push({ ...p });
        }
      }
      const places = merged.slice(0, 600);
      if (this.indexModel && places.length) {
        await this.indexModel
          .updateOne({ key }, { $set: { destination: scope.destination, places, fetched_at: new Date() } }, { upsert: true })
          .exec()
          .catch(() => undefined);
      }
      this.logger.log(`Lieux réels de ${scope.destination} : ${places.length} (OSM ${osm.length}, Wikipédia ${wikiFr.length + wikiEn.length})`);
      return places;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private async wikiGeosearch(lang: string, center: { lat: number; lng: number }): Promise<GroundedPlace[]> {
    try {
      const res = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
        params: {
          action: 'query',
          list: 'geosearch',
          gscoord: `${center.lat}|${center.lng}`,
          gsradius: 10000,
          gslimit: 150,
          format: 'json',
        },
        headers: UA,
        timeout: 6000,
      });
      return (res.data?.query?.geosearch || []).map((g: any) => ({
        name: String(g.title),
        lat: Number(g.lat),
        lng: Number(g.lon),
        source: 'wikipedia',
        wiki: { lang, title: String(g.title) },
      }));
    } catch (err: any) {
      this.logger.warn(`Wikipédia (${lang}) indisponible : ${err.message}`);
      return [];
    }
  }

  private async overpass(center: { lat: number; lng: number }): Promise<GroundedPlace[]> {
    const c = `${center.lat},${center.lng}`;
    const q = `[out:json][timeout:20];(
nwr(around:12000,${c})["name"]["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"];
nwr(around:12000,${c})["name"]["historic"~"^(monument|memorial|castle|fort|ruins|archaeological_site|palace|city_gate)$"];
nwr(around:12000,${c})["name"]["leisure"~"^(park|garden|nature_reserve)$"];
nwr(around:12000,${c})["name"]["amenity"~"^(marketplace|theatre|arts_centre|place_of_worship)$"];
nwr(around:12000,${c})["name"]["natural"="beach"];
nwr(around:6000,${c})["name"]["amenity"~"^(restaurant|cafe)$"];
);out center 700;`;
    try {
      const res = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(q)}`, {
        headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      });
      return (res.data?.elements || [])
        .map((e: any) => {
          const t = e.tags || {};
          const lat = Number(e.lat ?? e.center?.lat);
          const lng = Number(e.lon ?? e.center?.lon);
          const name = t['name:fr'] || t.name;
          if (!name || !isFinite(lat) || !isFinite(lng)) return null;
          const wikiTag = typeof t.wikipedia === 'string' ? /^([a-z]{2,3}):(.+)$/.exec(t.wikipedia) : null;
          const food = /^(restaurant|cafe)$/.test(t.amenity || '');
          return {
            name: String(name),
            lat,
            lng,
            source: 'osm',
            kind: this.kindLabel(t),
            food,
            ...(wikiTag ? { wiki: { lang: wikiTag[1], title: wikiTag[2] } } : {}),
          } as GroundedPlace;
        })
        .filter(Boolean);
    } catch (err: any) {
      this.logger.warn(`OpenStreetMap (Overpass) indisponible : ${err.message}`);
      return [];
    }
  }

  private kindLabel(t: Record<string, string>): string {
    const labels: Record<string, string> = {
      museum: 'musée', gallery: 'galerie', attraction: 'site', viewpoint: 'point de vue', zoo: 'zoo', theme_park: 'parc de loisirs',
      aquarium: 'aquarium', monument: 'monument', memorial: 'mémorial', castle: 'château', fort: 'fort', ruins: 'ruines',
      archaeological_site: 'site archéologique', palace: 'palais', city_gate: 'porte', park: 'parc', garden: 'jardin',
      nature_reserve: 'réserve naturelle', marketplace: 'marché', theatre: 'théâtre', arts_centre: 'centre culturel',
      place_of_worship: 'lieu de culte', beach: 'plage', restaurant: 'restaurant', cafe: 'café',
    };
    return labels[t.tourism] || labels[t.historic] || labels[t.leisure] || labels[t.amenity] || labels[t.natural] || 'lieu';
  }

  /** Texte pour le prompt : lieux réels connus, restaurants à part */
  promptContext(places: GroundedPlace[]): string {
    if (!places.length) return '';
    const sights = places.filter((p) => !p.food);
    // Les lieux qui ont un article Wikipédia d'abord (les plus notables)
    sights.sort((a, b) => Number(!!b.wiki) - Number(!!a.wiki));
    const food = places.filter((p) => p.food).slice(0, 40);
    const line = (p: GroundedPlace) => `${p.name}${p.kind && p.kind !== 'lieu' ? ` (${p.kind})` : ''}`;
    return `

## LIEUX RÉELS VÉRIFIÉS (OpenStreetMap / Wikipédia)
Choisis tes lieux EN PRIORITÉ dans ces listes, en recopiant le nom exact :
- Sites et visites : ${sights.slice(0, 90).map(line).join(' ; ')}${food.length ? `\n- Restaurants et cafés : ${food.map((p) => p.name).join(' ; ')}` : ''}
Un lieu absent de ces listes n'est accepté que s'il existe réellement et est vérifiable sur une carte. Chaque lieu sera contrôlé : un lieu introuvable sera retiré.`;
  }

  // ---------------------------------------------------------------------------
  // 2. Vérification des lieux proposés par l'IA
  // ---------------------------------------------------------------------------

  /**
   * Vérifie chaque lieu : trouvé dans la liste ou par géocodage → vraies coordonnées ;
   * introuvable → retiré. Renvoie aussi les lieux réels encore libres (pour remplacer).
   */
  async verify<T extends { name: string; lat: number; lng: number }>(
    items: T[],
    scope: GroundingScope,
    places: GroundedPlace[],
  ): Promise<{ kept: (T & { verified: boolean; source?: string; wiki?: { lang: string; title: string } })[]; dropped: T[] }> {
    const results = await pool(items, 5, async (item) => {
      const fromList = this.matchCandidate(item, scope, places);
      if (fromList) return { item, place: fromList as GroundedPlace | null | undefined };
      const geo = await this.geocode(item, scope);
      return { item, place: geo };
    });
    const kept: any[] = [];
    const dropped: T[] = [];
    for (const { item, place } of results) {
      if (place === undefined) {
        // Source de vérification indisponible : on garde le lieu, signalé « non vérifié » (sans image)
        kept.push({ ...item, verified: false });
        continue;
      }
      if (!place) {
        dropped.push(item);
        continue;
      }
      kept.push({ ...item, lat: place.lat, lng: place.lng, verified: true, source: place.source, ...(place.wiki ? { wiki: place.wiki } : {}) });
    }
    if (dropped.length) this.logger.warn(`${scope.destination} : ${dropped.length} lieu(x) introuvable(s) retiré(s) : ${dropped.map((d) => d.name).join(', ')}`);
    return { kept, dropped };
  }

  private inScope(p: { lat: number; lng: number }, scope: GroundingScope, countryCode?: string | null): boolean {
    if (scope.isCountry) return !scope.countryCode || !countryCode || countryCode.toUpperCase() === scope.countryCode;
    return kmBetween(p, scope.center) <= CITY_MAX_KM;
  }

  private matchCandidate(item: { name: string; lat: number; lng: number }, scope: GroundingScope, places: GroundedPlace[]): GroundedPlace | null {
    let best: GroundedPlace | null = null;
    let bestScore = 0;
    for (const p of places) {
      const s = nameSimilarity(item.name, p.name);
      if (s < 0.75) continue;
      // À nom égal, le plus proche des coordonnées proposées
      const near = isFinite(item.lat) && isFinite(item.lng) && item.lat !== 0 ? 1 / (1 + kmBetween(item, p)) : 0;
      const score = s + near * 0.2 + (p.wiki ? 0.05 : 0);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    return best && this.inScope(best, scope) ? best : null;
  }

  /**
   * Géocodage OpenStreetMap (Photon) : nom proche ET dans la zone du voyage.
   * null = introuvable ; undefined = service indisponible (on ne retire pas un lieu sur une panne).
   */
  private async geocode(item: { name: string; lat: number; lng: number }, scope: GroundingScope): Promise<GroundedPlace | null | undefined> {
    const bias = isFinite(item.lat) && item.lat !== 0 ? item : scope.center;
    const city = scope.destination.split(',')[0].trim();
    for (const q of [`${item.name} ${city}`, item.name]) {
      try {
        const res = await axios.get('https://photon.komoot.io/api/', {
          params: { q, lat: bias.lat, lon: bias.lng, limit: 5, lang: 'fr' },
          headers: UA,
          timeout: 5000,
        });
        for (const f of res.data?.features || []) {
          const p = f.properties || {};
          const [lng, lat] = f.geometry?.coordinates || [];
          if (!isFinite(lat) || !isFinite(lng) || !p.name) continue;
          if (nameSimilarity(item.name, p.name) < 0.6) continue;
          if (!this.inScope({ lat, lng }, scope, p.countrycode)) continue;
          return { name: p.name, lat, lng, source: 'osm' };
        }
      } catch (err: any) {
        this.logger.warn(`Géocodage de « ${item.name} » indisponible : ${err.message}`);
        return undefined;
      }
    }
    return null;
  }

  /** Lieux réels libres pour remplacer un lieu retiré : les plus proches du jour, notables d'abord */
  replacements(places: GroundedPlace[], used: string[], near: { lat: number; lng: number }, food: boolean, count: number): GroundedPlace[] {
    const taken = new Set(used.map(placeNorm));
    return places
      .filter((p) => !!p.food === food && !taken.has(placeNorm(p.name)))
      .filter((p) => kmBetween(p, near) <= 8)
      .sort((a, b) => Number(!!b.wiki) - Number(!!a.wiki) || kmBetween(a, near) - kmBetween(b, near))
      .slice(0, count);
  }

  /** Résumé Wikipédia (2 phrases) d'un lieu réel, pour décrire un remplaçant sans rien inventer */
  async extracts(items: { lang: string; title: string }[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const byLang = new Map<string, string[]>();
    for (const w of items) byLang.set(w.lang, [...(byLang.get(w.lang) || []), w.title]);
    await Promise.all(
      [...byLang.entries()].map(async ([lang, titles]) => {
        for (let i = 0; i < titles.length; i += 20) {
          try {
            const res = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
              params: { action: 'query', prop: 'extracts', exintro: 1, explaintext: 1, exsentences: 2, titles: titles.slice(i, i + 20).join('|'), redirects: 1, format: 'json' },
              headers: UA,
              timeout: 6000,
            });
            for (const page of Object.values<any>(res.data?.query?.pages || {})) {
              if (page?.extract) out.set(`${lang}:${page.title}`, String(page.extract).slice(0, 280));
            }
          } catch {
            // pas de résumé : description neutre
          }
        }
      }),
    );
    return out;
  }

  // ---------------------------------------------------------------------------
  // 3. Images du lieu lui-même
  // ---------------------------------------------------------------------------

  /** Image d'un lieu vérifié : article Wikipédia du lieu, sinon photo géolocalisée à moins de 150 m. */
  async imageFor(place: { name: string; lat: number; lng: number; wiki?: { lang: string; title: string } }): Promise<string | null> {
    if (place.wiki) {
      const url = await this.cached(`wiki:${place.wiki.lang}:${placeNorm(place.wiki.title)}`, `${place.wiki.lang}:${place.wiki.title}`, () =>
        this.wikiPageImage(place.wiki!.lang, place.wiki!.title),
      );
      if (url) return url;
    }
    if (!isFinite(place.lat) || !isFinite(place.lng)) return null;
    return this.cached(`geo:${place.lat.toFixed(4)},${place.lng.toFixed(4)}`, `${place.name} @ ${place.lat},${place.lng}`, () =>
      this.commonsNear(place.lat, place.lng),
    );
  }

  private async wikiPageImage(lang: string, title: string): Promise<string | null> {
    try {
      const res = await axios.get(`https://${lang}.wikipedia.org/w/api.php`, {
        params: { action: 'query', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: 1000, titles: title, redirects: 1, format: 'json' },
        headers: UA,
        timeout: 5000,
      });
      const page: any = Object.values(res.data?.query?.pages || {})[0];
      return page?.thumbnail?.source || null;
    } catch {
      return null;
    }
  }

  private async commonsNear(lat: number, lng: number): Promise<string | null> {
    try {
      const res = await axios.get('https://commons.wikimedia.org/w/api.php', {
        params: {
          action: 'query',
          generator: 'geosearch',
          ggscoord: `${lat}|${lng}`,
          ggsradius: 150,
          ggsnamespace: 6,
          ggslimit: 5,
          prop: 'imageinfo',
          iiprop: 'url|mime',
          iiurlwidth: 1000,
          format: 'json',
        },
        headers: UA,
        timeout: 5000,
      });
      const pages = Object.values<any>(res.data?.query?.pages || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const p of pages) {
        const info = p.imageinfo?.[0];
        if (info && /^image\/(jpeg|png|webp)$/.test(info.mime || 'image/jpeg')) return info.thumburl || info.url || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Catalogue partagé des images (clé stable par lieu) ; « rien trouvé » retenté après 7 jours */
  private async cached(key: string, query: string, load: () => Promise<string | null>): Promise<string | null> {
    if (!this.imageModel) return load();
    try {
      const doc: any = await this.imageModel.findOne({ key }).lean().exec();
      if (doc?.url) return doc.url;
      if (doc && Date.now() - new Date(doc.checked_at).getTime() < 7 * 24 * 3600_000) return null;
    } catch {
      return load();
    }
    const url = await load();
    await this.imageModel
      .updateOne({ key }, { $set: { query, url, checked_at: new Date() }, $setOnInsert: { hits: 0 } }, { upsert: true })
      .exec()
      .catch(() => undefined);
    return url;
  }
}
