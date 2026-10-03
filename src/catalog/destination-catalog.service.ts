import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AiService } from '../ai/ai.service';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { CatalogPlacePrice, CatalogPlacePriceDocument } from './schemas/catalog-place-price.schema';
import { CatalogDestination, CatalogDestinationDocument } from './schemas/catalog-destination.schema';

/** Prix d'entrée, pass, transport et repas : revus après 90 jours */
const PRICE_TTL_DAYS = 90;
/** Écart toléré entre un prix payé et le catalogue avant vérification */
const PAID_GAP = 0.15;
/** Deux paiements concordants (à 5 % près) en 60 jours suffisent pour corriger le prix */
const PAID_AGREE = 0.05;
const PAID_WINDOW_MS = 60 * 24 * 3600_000;

export interface CatalogActivity {
  name: string;
  price_adult: number;
  price_child: number;
  advice?: string;
  priced_at: Date;
  seasonal: boolean;
  source: string;
}

export interface CatalogExtras {
  activities: CatalogActivity[];
  local_transport?: { name: string; price_per_day: number; tip?: string };
  meals_per_person_per_day?: number;
  city_pass?: { name: string; price_adult: number; price_child?: number; covers: string[]; tip?: string };
  money_tips: string[];
  priced_at: Date | null;
}

export function catalogNorm(v: string): string {
  return (v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Catalogue partagé des destinations : « généré une fois, réutilisé toujours ».
 * Un prix a une date ; périmé (90 jours, ou relevé avant le 1er janvier), il reste servi pendant qu'on
 * le rafraîchit en arrière-plan. Les vrais paiements des voyageurs et les signalements le corrigent ;
 * un prix verrouillé par un admin n'est jamais écrasé.
 */
@Injectable()
export class DestinationCatalogService {
  private readonly logger = new Logger(DestinationCatalogService.name);
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly aiService: AiService,
    @InjectModel(CatalogPlacePrice.name, GLOBAL_DB_CONNECTION) private readonly placeModel: Model<CatalogPlacePriceDocument>,
    @InjectModel(CatalogDestination.name, GLOBAL_DB_CONNECTION) private readonly destModel: Model<CatalogDestinationDocument>,
  ) {}

  private placeKey(destination: string, name: string, currency: string) {
    return `${catalogNorm(destination)}|${catalogNorm(name)}|${currency}`;
  }

  private destKey(destination: string, month: number, level: string, currency: string) {
    return `${catalogNorm(destination)}|${month}|${level}|${currency}`;
  }

  /** Périmé : signalé, trop vieux, ou relevé avant le 1er janvier de cette année (hausses de début d'année) */
  isStale(doc: { priced_at?: Date; needs_refresh?: boolean; locked?: boolean } | null): boolean {
    if (!doc) return true;
    if (doc.locked) return false;
    if (doc.needs_refresh) return true;
    const at = doc.priced_at ? new Date(doc.priced_at).getTime() : 0;
    if (Date.now() - at > PRICE_TTL_DAYS * 24 * 3600_000) return true;
    return at < Date.UTC(new Date().getUTCFullYear(), 0, 1);
  }

  /**
   * Visites payantes, transport local, repas, pass et astuces pour un voyage.
   * Absent du catalogue : l'IA le génère (une fois). Périmé : servi tel quel, rafraîchi en arrière-plan.
   */
  async extras(o: {
    destination: string;
    country?: string;
    month: number;
    level: string;
    currency: string;
    places: string[];
    transports: string[];
  }): Promise<CatalogExtras | null> {
    const names = [...new Map(o.places.filter(Boolean).map((n) => [catalogNorm(n), n.trim()])).values()].slice(0, 25);
    const dKey = this.destKey(o.destination, o.month, o.level, o.currency);

    let [dest, docs] = await this.load(dKey, o, names);
    const missing = names.filter((n) => !docs.has(this.placeKey(o.destination, n, o.currency)));
    const stale = names.filter((n) => {
      const d = docs.get(this.placeKey(o.destination, n, o.currency));
      return d && this.isStale(d);
    });

    if (missing.length || !dest) {
      // Rien à servir : on attend la génération (l'écran, lui, n'attend pas : voir TripBookingsService)
      await this.fill(o, [...missing, ...stale], !dest || this.isStale(dest));
      [dest, docs] = await this.load(dKey, o, names);
    } else if (stale.length || this.isStale(dest)) {
      this.fill(o, stale, this.isStale(dest)).catch(() => undefined);
    }
    if (!dest && !docs.size) return null;

    const activities: CatalogActivity[] = [];
    for (const n of names) {
      const d: any = docs.get(this.placeKey(o.destination, n, o.currency));
      if (!d) continue;
      const peak = d.peak_price_adult && (d.peak_months || []).includes(o.month);
      const adult = peak ? d.peak_price_adult : d.price_adult;
      if (!adult) continue;
      activities.push({
        name: n,
        price_adult: adult,
        price_child: peak && d.price_adult ? Math.round((d.price_child * d.peak_price_adult) / d.price_adult) : d.price_child,
        advice: d.advice || undefined,
        priced_at: d.priced_at,
        seasonal: !!d.peak_price_adult,
        source: d.source,
      });
    }
    return {
      activities,
      local_transport: dest?.local_transport || undefined,
      meals_per_person_per_day: dest?.meals_per_person_per_day || undefined,
      city_pass: dest?.city_pass || undefined,
      money_tips: dest?.money_tips || [],
      priced_at: dest?.priced_at || null,
    };
  }

  private async load(dKey: string, o: { destination: string; currency: string }, names: string[]) {
    const keys = names.map((n) => this.placeKey(o.destination, n, o.currency));
    const [dest, list] = await Promise.all([
      this.destModel.findOne({ key: dKey }).lean().exec(),
      keys.length ? this.placeModel.find({ key: { $in: keys } }).lean().exec() : Promise.resolve([]),
    ]);
    return [dest as any, new Map((list as any[]).map((d) => [d.key, d]))] as const;
  }

  /** Une génération IA à la fois par destination ; les lieux omis par l'IA sont gratuits */
  private async fill(
    o: { destination: string; country?: string; month: number; level: string; currency: string; transports: string[] },
    places: string[],
    withDestination: boolean,
  ): Promise<boolean> {
    if (!places.length && !withDestination) return true;
    const jobKey = `${this.destKey(o.destination, o.month, o.level, o.currency)}|${places.map(catalogNorm).sort().join(',')}|${withDestination}`;
    if (this.inflight.has(jobKey)) return this.inflight.get(jobKey)!;
    const job = (async () => {
      const res = await this.aiService.estimateDestinationExtras({
        destination: o.destination,
        country: o.country,
        month: o.month,
        level: o.level,
        currency: o.currency,
        places,
        transports: o.transports,
        with_destination: withDestination,
      });
      if (!res) return false;
      const now = new Date();

      if (places.length) {
        const byName = new Map(res.places.map((p) => [catalogNorm(p.name), p]));
        const match = (n: string) => {
          const k = catalogNorm(n);
          if (byName.has(k)) return byName.get(k);
          for (const [key, p] of byName) if (key.includes(k) || k.includes(key)) return p;
          return undefined;
        };
        // Réponse trop incomplète (coupée) : on ne déclare pas « gratuits » les lieux manquants
        const trustOmissions = res.places.length >= places.length * 0.6;
        const existing = new Map(
          ((await this.placeModel
            .find({ key: { $in: places.map((n) => this.placeKey(o.destination, n, o.currency)) } })
            .lean()
            .exec()) as any[]).map((d) => [d.key, d]),
        );
        const ops: any[] = [];
        for (const n of places) {
          const p = match(n);
          if (!p && !trustOmissions) continue;
          const key = this.placeKey(o.destination, n, o.currency);
          const prev: any = existing.get(key);
          if (prev?.locked) continue;
          const next = {
            price_adult: p?.price_adult ?? 0,
            price_child: p?.price_child ?? 0,
            peak_price_adult: p?.peak_price_adult ?? null,
            peak_months: p?.peak_months ?? [],
            advice: p?.advice ?? null,
          };
          const update: any = {
            $set: { ...next, destination: catalogNorm(o.destination), name: n, currency: o.currency, priced_at: now, source: 'ia', needs_refresh: false },
          };
          if (prev && (prev.price_adult !== next.price_adult || prev.price_child !== next.price_child)) {
            update.$push = {
              history: { $each: [{ price_adult: prev.price_adult, price_child: prev.price_child, at: prev.priced_at, source: prev.source }], $slice: -10 },
            };
          }
          ops.push({ updateOne: { filter: { key }, update, upsert: true } });
        }
        if (ops.length) await this.placeModel.bulkWrite(ops, { ordered: false });
      }

      if (withDestination) {
        const dKey = this.destKey(o.destination, o.month, o.level, o.currency);
        await this.destModel
          .updateOne(
            { key: dKey, locked: { $ne: true } },
            {
              $set: {
                destination: catalogNorm(o.destination),
                month: o.month,
                level: o.level,
                currency: o.currency,
                local_transport: res.local_transport ?? null,
                meals_per_person_per_day: res.meals_per_person_per_day ?? null,
                city_pass: res.city_pass ?? null,
                money_tips: res.money_tips ?? [],
                priced_at: now,
                needs_refresh: false,
              },
            },
            { upsert: true },
          )
          .exec()
          .catch((err) => {
            // Fiche verrouillée par un admin : l'upsert bute sur la clé unique, rien à faire
            if (err?.code !== 11000) throw err;
          });
      }
      return true;
    })()
      .catch((err) => {
        this.logger.warn(`Catalogue ${o.destination} : ${err.message}`);
        return false;
      })
      .finally(() => this.inflight.delete(jobKey));
    this.inflight.set(jobKey, job);
    return job;
  }

  // ---------------------------------------------------------------------------
  // Corrections : vrais paiements et signalements
  // ---------------------------------------------------------------------------

  /**
   * Un voyageur a payé une visite : au-delà de 15 % d'écart, le prix est à vérifier ;
   * deux paiements concordants en 60 jours corrigent directement le catalogue.
   */
  async reportPaid(o: { destination: string; name: string; currency: string; amount: number; adults: number; kids: number[]; userId: string }) {
    const key = this.placeKey(o.destination, o.name, o.currency);
    const doc: any = await this.placeModel.findOne({ key }).lean().exec();
    if (!doc || !doc.price_adult || o.amount <= 0) return;
    const expected = doc.price_adult * Math.max(1, o.adults) + (doc.price_child || 0) * o.kids.length;
    if (!expected) return;
    const ratio = o.amount / expected;
    const perAdult = Math.round(doc.price_adult * ratio);
    const report = { per_adult: perAdult, at: new Date(), user_id: o.userId, kind: 'paid' as const };
    if (Math.abs(ratio - 1) <= PAID_GAP) {
      await this.placeModel.updateOne({ key }, { $push: { reports: { $each: [report], $slice: -20 } } }).exec();
      return;
    }

    const recent = (doc.reports || []).filter(
      (r: any) => r.kind === 'paid' && Date.now() - new Date(r.at).getTime() < PAID_WINDOW_MS && r.user_id !== o.userId,
    );
    const agreeing = recent.filter((r: any) => Math.abs(r.per_adult - perAdult) <= perAdult * PAID_AGREE);
    if (agreeing.length >= 1 && !doc.locked) {
      // Deuxième voyageur à payer ce nouveau tarif : le catalogue le prend
      const avg = Math.round([perAdult, ...agreeing.map((r: any) => r.per_adult)].reduce((a, b) => a + b, 0) / (agreeing.length + 1));
      await this.placeModel
        .updateOne(
          { key },
          {
            $set: {
              price_adult: avg,
              price_child: Math.round((doc.price_child || 0) * (avg / doc.price_adult)),
              priced_at: new Date(),
              source: 'voyageurs',
              needs_refresh: false,
            },
            $push: {
              reports: { $each: [report], $slice: -20 },
              history: { $each: [{ price_adult: doc.price_adult, price_child: doc.price_child, at: doc.priced_at, source: doc.source }], $slice: -10 },
            },
          },
        )
        .exec();
      this.logger.log(`Catalogue : ${doc.name} (${doc.destination}) corrigé par les voyageurs : ${doc.price_adult} → ${avg}`);
      return;
    }
    await this.placeModel
      .updateOne({ key }, { $set: { needs_refresh: true }, $push: { reports: { $each: [report], $slice: -20 } } })
      .exec();
  }

  /** « Prix incorrect ? » : le prix sera revérifié au prochain passage */
  async flag(o: { destination: string; name: string; currency: string; userId: string }) {
    const key = this.placeKey(o.destination, o.name, o.currency);
    const res = await this.placeModel
      .updateOne(
        { key },
        { $set: { needs_refresh: true }, $push: { reports: { $each: [{ per_adult: 0, at: new Date(), user_id: o.userId, kind: 'flag' }], $slice: -20 } } },
      )
      .exec();
    return { flagged: res.matchedCount > 0 };
  }
}
