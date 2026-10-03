import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { TenancyService } from '../tenancy/tenancy.service';
import { AiService, BookingEstimatesDraft } from '../ai/ai.service';
import { User, UserDocument } from '../auth/schemas/user.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { TripDocument, TripSchema } from './schemas/trip.schema';
import { distanceMeters } from './trip-gems.service';
import { TravelpayoutsService } from './travelpayouts.service';
import {
  AFFILIATE_PARTNERS,
  PartnerChoice,
  activityChoices,
  carChoices,
  esimChoices,
  lodgingChoices,
  transferChoices,
} from './partner-links';

/** Budget par personne et par jour quand le voyageur n'a pas annoncé de montant (EUR) */
const DAILY_BUDGET_BY_LEVEL: Record<string, number> = { economique: 70, moyen: 140, luxe: 320 };

/** Répartition du budget selon le standing (hébergement, transports, activités, repas & extras) */
const SPLIT_BY_LEVEL: Record<string, { lodging: number; transport: number; activities: number; meals: number }> = {
  economique: { lodging: 0.38, transport: 0.17, activities: 0.15, meals: 0.3 },
  moyen: { lodging: 0.45, transport: 0.15, activities: 0.15, meals: 0.25 },
  luxe: { lodging: 0.52, transport: 0.13, activities: 0.15, meals: 0.2 },
};

/** Au-delà de cette distance entre deux journées, on change d'hébergement */
const NEW_STAY_DISTANCE_M = 25000;

export const BOOKING_CATEGORIES = ['lodging', 'transport', 'activities', 'meals', 'flights', 'other'] as const;
type BookingCategory = (typeof BOOKING_CATEGORIES)[number];

/**
 * Réservations & Budget : à partir du voyage (dates, groupe, budget, lieux), propose où dormir,
 * comment se déplacer et quelles visites réserver, avec des liens pré-remplis (dates, voyageurs,
 * plafond de prix) vers les partenaires, et suit ce qui a été réservé.
 */
@Injectable()
export class TripBookingsService {
  private readonly logger = new Logger(TripBookingsService.name);
  private readonly pending = new Map<string, Promise<BookingEstimatesDraft | null>>();

  constructor(
    private readonly tenancyService: TenancyService,
    private readonly aiService: AiService,
    private readonly config: ConfigService,
    private readonly travelpayouts: TravelpayoutsService,
    @InjectModel(User.name, GLOBAL_DB_CONNECTION) private readonly userModel: Model<UserDocument>,
  ) {}

  private tripModel(userId: string) {
    return this.tenancyService.getTenantModel<TripDocument>(userId, 'Trip', TripSchema);
  }

  private async loadTrip(userId: string, tripId: string): Promise<any> {
    const TripModel = await this.tripModel(userId);
    const trip: any = await TripModel.findOne({ id: tripId, user_id: userId })
      .select(
        'id destination city country country_code duration_days start_date budget budget_amount currency travelers transports pois weather bookings_plan bookings cover_image_url',
      )
      .lean()
      .exec();
    if (!trip) throw new NotFoundException(`Trip ${tripId} not found`);
    return trip;
  }

  // ---------------------------------------------------------------------------
  // Vue complète
  // ---------------------------------------------------------------------------

  async get(userId: string, tripId: string) {
    const trip = await this.loadTrip(userId, tripId);
    const user: any = await this.userModel.findOne({ user_id: userId }).select('city country').lean().exec();
    const choiceLists: PartnerChoice[][] = [];

    const currency = trip.currency || 'EUR';
    const level = SPLIT_BY_LEVEL[trip.budget] ? trip.budget : 'moyen';
    const adults = Math.max(1, trip.travelers?.adults ?? 1);
    const kids: number[] = trip.travelers?.children_ages ?? [];
    const days = Math.max(1, trip.duration_days || 1);
    const nights = Math.max(0, days - 1);
    // Un enfant compte pour une demi-part dans l'estimation
    const shares = adults + kids.length * 0.5;

    const announced = trip.budget_amount && trip.budget_amount > 0;
    const total = announced
      ? Math.round(trip.budget_amount)
      : Math.round(DAILY_BUDGET_BY_LEVEL[level] * days * shares);
    const split = SPLIT_BY_LEVEL[level];
    const allocation = {
      lodging: Math.round(total * split.lodging),
      transport: Math.round(total * split.transport),
      activities: Math.round(total * split.activities),
      meals: Math.round(total * split.meals),
    };

    const stays = this.buildStays(trip);
    const startDate = this.parseDay(trip.start_date);
    const lodgingNightCap = nights ? Math.round(allocation.lodging / nights) : 0;
    const home = user?.city || user?.country;
    const where = trip.city || trip.destination;
    const returnDate = startDate ? this.addDays(startDate, days - 1) : null;
    // Estimations IA et vrais prix des vols en parallèle (le vol ne bloque jamais l'écran)
    const [estimates, flight] = await Promise.all([
      this.estimates(userId, trip, stays, level, currency, adults, kids, lodgingNightCap),
      home
        ? this.withTimeout(
            this.travelpayouts.flightQuote({ from: home, to: where, departure: startDate, returnDate, currency, adults, kids }),
            9000,
          )
        : Promise.resolve(null),
    ]);

    const staysDto = stays.map((stay) => {
      const est = estimates?.stays.find((s) => s.index === stay.index);
      const checkin = startDate ? this.addDays(startDate, stay.fromDay - 1) : null;
      const checkout = startDate ? this.addDays(startDate, stay.fromDay - 1 + stay.nights) : null;
      const area = est?.area || stay.label;
      const where = `${area}, ${trip.city || trip.destination}`;
      const city = trip.city || trip.destination;
      const search = { checkin, checkout, adults, kids, currency, maxPerNight: lodgingNightCap };
      const bookingUrl = this.bookingUrl({ where, ...search });
      const airbnbUrl = this.airbnbUrl({ where, ...search });
      const choices = lodgingChoices({ where, ...search }, bookingUrl, airbnbUrl);
      choiceLists.push(choices);
      // Autres façons de dormir, les moins chères d'abord, chacune avec ses recherches pré-remplies
      const options = (est?.options || [])
        .map((o) => {
          const optWhere = `${o.area}, ${city}`;
          // Filtre de prix à la hauteur de l'option (sinon une option à peine au-dessus serait masquée)
          const optSearch = { ...search, maxPerNight: Math.max(lodgingNightCap, o.nightly_max) };
          const optChoices = lodgingChoices(
            { where: optWhere, ...optSearch },
            this.bookingUrl({ where: optWhere, ...optSearch }),
            this.airbnbUrl({ where: optWhere, ...optSearch }),
          ).filter((c) => c.partner === 'booking' || c.partner === 'airbnb');
          choiceLists.push(optChoices);
          return {
            kind: o.kind,
            area: o.area,
            why: o.why,
            nightly_min: o.nightly_min,
            nightly_max: o.nightly_max,
            fits_budget: !lodgingNightCap || o.nightly_min <= lodgingNightCap,
            choices: optChoices,
          };
        })
        .sort((a, b) => a.nightly_min - b.nightly_min);
      return {
        index: stay.index,
        from_day: stay.fromDay,
        to_day: stay.toDay,
        nights: stay.nights,
        area,
        why: est?.why || null,
        tip: est?.tip || null,
        near: stay.near.slice(0, 3),
        nightly_min: est?.nightly_min ?? null,
        nightly_max: est?.nightly_max ?? null,
        nightly_budget: lodgingNightCap,
        checkin,
        checkout,
        links: { booking: bookingUrl, airbnb: airbnbUrl },
        choices,
        options,
      };
    }).filter((s) => s.nights > 0);

    // Transports : entre étapes, sur place, et aller-retour depuis chez soi
    const transport: any[] = [];
    for (let i = 1; i < stays.length; i++) {
      const a = stays[i - 1];
      const b = stays[i];
      if (!a.center || !b.center) continue;
      transport.push({
        kind: 'intercity',
        title: `${a.label} → ${b.label}`,
        subtitle: `Jour ${b.fromDay} · ${Math.round(distanceMeters(a.center.lat, a.center.lng, b.center.lat, b.center.lng) / 1000)} km`,
        link: `https://www.google.com/maps/dir/?api=1&origin=${a.center.lat},${a.center.lng}&destination=${b.center.lat},${b.center.lng}&travelmode=transit`,
      });
    }
    const local = estimates?.local_transport;
    const modes: string[] = (trip.transports || []).map((m: string) => m.toLowerCase());
    if (local) {
      transport.push({
        kind: 'pass',
        title: local.name,
        subtitle: local.tip || 'Transports en commun sur place',
        price: Math.round(local.price_per_day * days * Math.max(1, adults)),
        price_label: `${local.price_per_day} ${currency}/jour/pers.`,
      });
    }
    const center = stays[0]?.center;
    if (center && modes.some((m) => /voiture|car/.test(m))) {
      const choices = carChoices();
      choiceLists.push(choices);
      transport.push({
        kind: 'car',
        title: 'Location de voiture',
        subtitle: startDate
          ? `Du ${this.frDate(startDate)} au ${this.frDate(this.addDays(startDate, days - 1))} · ${days} jour${days > 1 ? 's' : ''}`
          : `${days} jour${days > 1 ? 's' : ''} sur place`,
        link: choices[0].url,
        choices,
      });
    }
    if (center && modes.some((m) => /velo|vélo|bike/.test(m))) {
      transport.push({
        kind: 'bike',
        title: 'Vélos en libre-service',
        subtitle: 'Stations et loueurs autour de ton hébergement',
        link: `https://www.google.com/maps/search/location+de+v%C3%A9los/@${center.lat},${center.lng},14z`,
      });
    }
    // Vols : vrais prix Aviasales (Travelpayouts) quand on connaît la ville de départ, sinon comparateur
    const passengers = adults + kids.filter((a) => a >= 2).length;
    const best = flight?.offers[0] ?? null;
    transport.unshift({
      kind: 'flight',
      title: home ? `${home} → ${where}` : `Vols vers ${where}`,
      subtitle: startDate
        ? `Aller le ${this.frDate(startDate)} · retour le ${this.frDate(returnDate!)}`
        : 'Ajoute tes dates pour comparer les vols',
      link: flight?.search_link || this.flightsUrl(home, where, startDate, returnDate, adults, kids.length),
      price: best ? best.price * passengers : undefined,
      price_label: best ? `dès ${best.price} ${currency}/pers. aller-retour` : undefined,
      origin_code: flight?.origin.code ?? null,
      destination_code: flight?.destination.code ?? null,
      offers: flight?.offers ?? [],
      cheaper_dates: (flight?.cheaper_dates ?? []).map((o) => ({ ...o, saving: best ? (best.price - o.price) * passengers : null })),
      // Comparatif : repères, ± 3 jours, aéroports proches, verdict sur le prix
      highlights: flight?.highlights ?? [],
      flexible: (flight?.flexible ?? []).map((f) => ({ ...f, saving: best ? (best.price - f.price) * passengers : null })),
      nearby: (flight?.nearby ?? []).map((n) => ({ ...n, saving: best ? (best.price - n.price) * passengers : null })),
      insight: flight?.insight ?? null,
      passengers,
      live_prices: !!flight,
      outside_budget: true,
      choices: [{ partner: 'aviasales', label: 'Aviasales', url: flight?.search_link || this.flightsUrl(home, where, startDate, returnDate, adults, kids.length) }],
    });

    // Transfert aéroport → premier hébergement, à prix fixe
    const firstStay = staysDto[0];
    if (firstStay) {
      const choices = transferChoices();
      choiceLists.push(choices);
      const people = adults + kids.length;
      transport.splice(1, 0, {
        kind: 'transfer',
        title: `Aéroport → ${firstStay.area}`,
        subtitle: `${startDate ? `Le ${this.frDate(startDate)} · ` : ''}${people} voyageur${people > 1 ? 's' : ''}${kids.length ? ', sièges enfant sur demande' : ''} · prix fixé à la réservation`,
        link: choices[0].url,
        choices,
      });
    }

    // eSIM : internet dès l'atterrissage, sans frais d'itinérance
    const sameCountry = user?.country && trip.country && String(user.country).trim().toLowerCase() === String(trip.country).trim().toLowerCase();
    if (trip.country && !sameCountry) {
      const choices = esimChoices(trip.country_code);
      choiceLists.push(choices);
      transport.push({
        kind: 'esim',
        title: `eSIM ${trip.country}`,
        subtitle: 'Internet dès l’atterrissage, sans frais d’itinérance ni carte SIM à changer',
        link: choices[0].url,
        choices,
      });
    }

    // Activités payantes (estimations), avec billets en ligne
    const activities = (estimates?.activities || []).map((a) => {
      const poi = (trip.pois || []).find((p: any) => p.name?.toLowerCase() === a.name.toLowerCase());
      const price = Math.round(a.price_adult * adults + (a.price_child ?? a.price_adult) * kids.length);
      return {
        name: a.name,
        day: poi?.day ?? null,
        price_adult: a.price_adult,
        price_child: a.price_child ?? null,
        price_group: price,
        advice: a.advice || null,
        image_url: poi?.image_url || null,
        link: '',
        choices: activityChoices(a.name, trip.city || trip.destination),
      };
    });
    for (const a of activities) {
      a.link = a.choices[0].url;
      choiceLists.push(a.choices);
    }

    const meals = estimates?.meals_per_person_per_day
      ? Math.round(estimates.meals_per_person_per_day * days * shares)
      : allocation.meals;

    // Pass touristique ou billets à l'unité : le moins cher pour ce groupe et cet itinéraire
    const passCompare = this.comparePass(estimates?.city_pass, activities, adults, kids);

    // Le meilleur plan : coût estimé sur place, vols, et économies possibles classées
    const lodgingNeed = staysDto.reduce(
      (s, x) => s + (x.nightly_min != null ? Math.round(((x.nightly_min + (x.nightly_max ?? x.nightly_min)) / 2) * x.nights) : x.nightly_budget * x.nights),
      0,
    );
    const activitiesNeed = activities.reduce((s, a) => s + a.price_group, 0) - (passCompare?.worth_it ? passCompare.saving : 0);
    const localNeed = local ? Math.round(local.price_per_day * days * Math.max(1, adults)) : 0;
    const costOnSite = lodgingNeed + activitiesNeed + meals + localNeed;
    const flightsGroup = best ? best.price * passengers : null;
    const savings: { kind: string; title: string; detail: string; amount: number; tab: number }[] = [];
    for (const x of staysDto) {
      const cheapest = x.options.find((o) => o.fits_budget) ?? x.options[0];
      if (!cheapest || x.nightly_min == null) continue;
      const ideal = ((x.nightly_min + (x.nightly_max ?? x.nightly_min)) / 2) * x.nights;
      const alt = ((cheapest.nightly_min + cheapest.nightly_max) / 2) * x.nights;
      if (ideal - alt > Math.max(20, ideal * 0.08)) {
        savings.push({
          kind: 'lodging',
          title: `${cheapest.kind} à ${cheapest.area}`,
          detail: `${x.nights} nuit${x.nights > 1 ? 's' : ''} au lieu de ${x.area}`,
          amount: Math.round(ideal - alt),
          tab: 1,
        });
      }
    }
    if (passCompare?.worth_it) {
      savings.push({ kind: 'pass', title: `Prendre le ${passCompare.name}`, detail: `Couvre ${passCompare.covers.length} visites de ton itinéraire`, amount: passCompare.saving, tab: 3 });
    }
    const bestFlex = (flight?.flexible ?? []).filter((f) => best && f.price < best.price).sort((a, b) => a.price - b.price)[0];
    if (bestFlex && best) {
      savings.push({
        kind: 'flight_dates',
        title: `Partir le ${this.frDate(bestFlex.departure)}`,
        detail: `Même durée de séjour${bestFlex.return ? `, retour le ${this.frDate(bestFlex.return)}` : ''}`,
        amount: (best.price - bestFlex.price) * passengers,
        tab: 2,
      });
    }
    const bestNear = flight?.nearby[0];
    if (bestNear && best) {
      savings.push({
        kind: 'flight_airport',
        title: `Vol ${bestNear.origin} → ${bestNear.destination}`,
        detail: 'Aéroport voisin, même période',
        amount: (best.price - bestNear.price) * passengers,
        tab: 2,
      });
    }
    savings.sort((a, b) => b.amount - a.amount);
    const plan = {
      cost_on_site: costOnSite,
      budget_total: total,
      fits: costOnSite <= total,
      gap: costOnSite - total,
      flights_group: flightsGroup,
      total_with_flights: flightsGroup != null ? costOnSite + flightsGroup : null,
      savings: savings.filter((x) => x.amount > 0).slice(0, 4),
      money_tips: estimates?.money_tips ?? [],
      booking_window: estimates?.booking_window ?? null,
    };

    const daily = this.buildDaily(trip, staysDto, activities, startDate, {
      days,
      shares,
      adults,
      mealsPerPersonDay: estimates?.meals_per_person_per_day ?? Math.round(allocation.meals / days / shares),
      localPerDay: local ? Math.round(local.price_per_day * Math.max(1, adults)) : 0,
      dailyBudget: Math.round(total / days),
    });

    // Liens affiliés Travelpayouts pour toutes les marques partenaires (les autres restent tels quels)
    const toConvert = choiceLists.flat().filter((c) => AFFILIATE_PARTNERS.has(c.partner)).map((c) => c.url);
    const converted = await this.withTimeout(this.travelpayouts.affiliate(toConvert), 4500);
    if (converted) {
      for (const c of choiceLists.flat()) c.url = converted[c.url] || c.url;
      for (const x of staysDto) x.links.booking = x.choices.find((c) => c.partner === 'booking')?.url || x.links.booking;
      for (const a of activities) a.link = a.choices[0].url;
      for (const t of transport) if (t.choices?.length && t.kind !== 'flight') t.link = t.choices[0].url;
    }

    const booked = (trip.bookings || []) as any[];
    const spent = booked.filter((b) => b.category !== 'flights').reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const flightsSpent = booked.filter((b) => b.category === 'flights').reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
    const spentBy = (cat: string) => booked.filter((b) => b.category === cat).reduce((s, b) => s + (Number(b.amount) || 0), 0);

    return {
      trip_id: trip.id,
      destination: trip.city || trip.destination,
      cover_image_url: trip.cover_image_url || null,
      currency,
      level,
      announced_budget: !!announced,
      dates_known: !!startDate,
      travelers: { adults, children_ages: kids, party: trip.travelers?.party || null },
      days,
      nights,
      budget: {
        total,
        allocation,
        spent,
        spent_by: {
          lodging: spentBy('lodging'),
          transport: spentBy('transport'),
          activities: spentBy('activities'),
          meals: spentBy('meals'),
          other: spentBy('other'),
        },
        flights_spent: flightsSpent,
        available: total - spent,
        estimated_needs: {
          lodging: staysDto.reduce((s, x) => s + (x.nightly_min != null ? Math.round(((x.nightly_min + (x.nightly_max ?? x.nightly_min)) / 2) * x.nights) : 0), 0),
          activities: activities.reduce((s, a) => s + a.price_group, 0),
          meals,
        },
      },
      stays: staysDto,
      daily,
      transport,
      activities,
      pass_compare: passCompare,
      plan,
      bookings: booked.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
      estimates_available: !!estimates,
    };
  }

  // ---------------------------------------------------------------------------
  // Prestations réservées
  // ---------------------------------------------------------------------------

  async add(userId: string, tripId: string, dto: { category: string; label: string; amount: number; url?: string; date?: string }) {
    if (!BOOKING_CATEGORIES.includes(dto.category as BookingCategory)) throw new BadRequestException('Catégorie inconnue');
    const label = (dto.label || '').trim().slice(0, 100);
    if (!label) throw new BadRequestException('Nom de la prestation manquant');
    const TripModel = await this.tripModel(userId);
    const item = {
      id: uuidv4().slice(0, 8),
      category: dto.category,
      label,
      amount: Math.max(0, Math.round(Number(dto.amount) || 0)),
      url: dto.url?.slice(0, 500) || null,
      date: dto.date?.slice(0, 10) || null,
      created_at: new Date(),
    };
    const res = await TripModel.updateOne({ id: tripId, user_id: userId }, { $push: { bookings: item } }).exec();
    if (res.matchedCount === 0) throw new NotFoundException(`Trip ${tripId} not found`);
    return this.get(userId, tripId);
  }

  async remove(userId: string, tripId: string, itemId: string) {
    const TripModel = await this.tripModel(userId);
    await TripModel.updateOne({ id: tripId, user_id: userId }, { $pull: { bookings: { id: itemId } } }).exec();
    return this.get(userId, tripId);
  }

  // ---------------------------------------------------------------------------
  // Jour par jour : où l'on dort, ce qu'on visite, ce que ça coûte
  // ---------------------------------------------------------------------------

  private buildDaily(
    trip: any,
    stays: { from_day: number; to_day: number; nights: number; area: string; nightly_min: number | null; nightly_max: number | null; nightly_budget: number }[],
    activities: { name: string; day: number | null; price_group: number }[],
    startDate: string | null,
    o: { days: number; shares: number; adults: number; mealsPerPersonDay: number; localPerDay: number; dailyBudget: number },
  ) {
    const pois: any[] = trip.pois || [];
    const weather: any[] = trip.weather || [];
    const out: any[] = [];
    for (let d = 1; d <= o.days; d++) {
      const date = startDate ? this.addDays(startDate, d - 1) : null;
      const stay = stays.find((s) => d >= s.from_day && d <= s.to_day);
      // On dort sur place tous les soirs sauf le dernier
      const sleeps = d < o.days && !!stay;
      const lodging = sleeps
        ? stay!.nightly_min != null
          ? Math.round((stay!.nightly_min + (stay!.nightly_max ?? stay!.nightly_min)) / 2)
          : stay!.nightly_budget
        : 0;
      const dayPois = pois.filter((p) => p.day === d).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const paid = activities.filter((a) => a.day === d);
      const activitiesCost = paid.reduce((s, a) => s + a.price_group, 0);
      const meals = Math.round(o.mealsPerPersonDay * o.shares);
      const transport = o.localPerDay;
      const w = date ? weather.find((x) => x?.date === date) : weather[d - 1];
      const totalDay = lodging + activitiesCost + meals + transport;
      out.push({
        day: d,
        date,
        area: stay?.area ?? null,
        sleeps,
        weather: w ? { icon: w.icon ?? null, temp_max: w.temp_max ?? null, temp_min: w.temp_min ?? null, summary: w.summary ?? null } : null,
        places: dayPois.map((p) => ({
          name: p.name,
          price: paid.find((a) => a.name.toLowerCase() === String(p.name).toLowerCase())?.price_group ?? 0,
          duration_minutes: p.duration_minutes ?? null,
        })),
        costs: { lodging, activities: activitiesCost, meals, transport },
        total: totalDay,
        budget: o.dailyBudget,
      });
    }
    return out;
  }

  /** Pass touristique comparé aux billets à l'unité des visites qu'il couvre */
  private comparePass(
    pass: BookingEstimatesDraft['city_pass'],
    activities: { name: string; price_group: number }[],
    adults: number,
    kids: number[],
  ) {
    if (!pass) return null;
    const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
    const covered = activities.filter((a) => pass.covers.some((c) => norm(c) === norm(a.name) || norm(a.name).includes(norm(c)) || norm(c).includes(norm(a.name))));
    if (covered.length < 2) return null;
    const individual = covered.reduce((s, a) => s + a.price_group, 0);
    const priceGroup = Math.round(pass.price_adult * adults + (pass.price_child ?? pass.price_adult) * kids.length);
    return {
      name: pass.name,
      price_group: priceGroup,
      covers: covered.map((a) => a.name),
      individual_total: individual,
      saving: individual - priceGroup,
      worth_it: individual - priceGroup > 0,
      tip: pass.tip ?? null,
    };
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Étapes d'hébergement : journées regroupées par zone géographique
  // ---------------------------------------------------------------------------

  private buildStays(trip: any) {
    const days = Math.max(1, trip.duration_days || 1);
    const pois: any[] = trip.pois || [];
    const dayCenter = (d: number) => {
      const list = pois.filter((p) => p.day === d && p.lat && p.lng);
      if (!list.length) return null;
      return {
        lat: list.reduce((s, p) => s + Number(p.lat), 0) / list.length,
        lng: list.reduce((s, p) => s + Number(p.lng), 0) / list.length,
        names: list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((p) => p.name),
      };
    };

    const stays: { index: number; fromDay: number; toDay: number; center: { lat: number; lng: number } | null; near: string[] }[] = [];
    for (let d = 1; d <= days; d++) {
      const c = dayCenter(d);
      const current = stays[stays.length - 1];
      if (current && (!c || !current.center || distanceMeters(current.center.lat, current.center.lng, c.lat, c.lng) < NEW_STAY_DISTANCE_M)) {
        current.toDay = d;
        if (c) current.near.push(...c.names);
      } else if (c) {
        stays.push({ index: stays.length + 1, fromDay: d, toDay: d, center: { lat: c.lat, lng: c.lng }, near: [...c.names] });
      }
    }
    // Lieux sans coordonnées : un seul hébergement pour tout le séjour
    if (!stays.length) stays.push({ index: 1, fromDay: 1, toDay: days, center: null, near: pois.map((p) => p.name).slice(0, 6) });
    // Nuits : on dort sur place jusqu'au départ (le dernier jour, on rentre)
    return stays.map((s, i) => {
      const last = i === stays.length - 1;
      const nights = last ? Math.max(0, s.toDay - s.fromDay) : s.toDay - s.fromDay + 1;
      return { ...s, nights, label: stays.length > 1 ? `Étape ${s.index}` : trip.city || trip.destination };
    });
  }

  /** Estimations IA, calculées une fois par combinaison dates / groupe / budget puis gardées. */
  private async estimates(
    userId: string,
    trip: any,
    stays: ReturnType<TripBookingsService['buildStays']>,
    level: string,
    currency: string,
    adults: number,
    kids: number[],
    nightlyCap: number,
  ): Promise<BookingEstimatesDraft | null> {
    // v3 : options d'hébergement, pass touristique, astuces
    const basis = ['v3', trip.start_date || '', trip.duration_days, level, currency, adults, kids.join('.'), stays.length, nightlyCap].join('|');
    if (trip.bookings_plan?.basis === basis && trip.bookings_plan?.estimates) return trip.bookings_plan.estimates;

    const key = `${userId}:${trip.id}:${basis}`;
    if (!this.pending.has(key)) {
      this.pending.set(
        key,
        (async () => {
          const estimates = await this.aiService.estimateBookings({
            destination: trip.city || trip.destination,
            country: trip.country,
            level,
            currency,
            start_date: trip.start_date,
            adults,
            children_ages: kids,
            stays: stays.map((s) => ({
              index: s.index,
              days: s.fromDay === s.toDay ? `jour ${s.fromDay}` : `jours ${s.fromDay} à ${s.toDay}`,
              near: s.near,
            })),
            places: (trip.pois || []).filter((p: any) => p.order !== 2).map((p: any) => p.name),
            transports: trip.transports || [],
            nightly_cap: nightlyCap || undefined,
          });
          if (estimates) {
            const TripModel = await this.tripModel(userId);
            await TripModel.updateOne(
              { id: trip.id, user_id: userId },
              { $set: { bookings_plan: { basis, estimates, generated_at: new Date() } } },
            ).exec();
          }
          return estimates;
        })().finally(() => this.pending.delete(key)),
      );
    }
    return this.pending.get(key)!;
  }

  // ---------------------------------------------------------------------------
  // Liens partenaires pré-remplis
  // ---------------------------------------------------------------------------

  private bookingUrl(o: {
    where: string;
    checkin: string | null;
    checkout: string | null;
    adults: number;
    kids: number[];
    currency: string;
    maxPerNight: number;
  }) {
    const params = new URLSearchParams({
      ss: o.where,
      group_adults: String(o.adults),
      group_children: String(o.kids.length),
      no_rooms: String(Math.max(1, Math.ceil(o.adults / 2))),
      selected_currency: o.currency,
      lang: 'fr',
    });
    for (const age of o.kids) params.append('age', String(age));
    if (o.checkin) params.set('checkin', o.checkin);
    if (o.checkout) params.set('checkout', o.checkout);
    if (o.maxPerNight > 0) params.set('nflt', `price=${o.currency}-0-${o.maxPerNight}-1`);
    // Identifiant affilié Booking.com (commissions) si configuré
    const aid = this.config.get<string>('BOOKING_AFFILIATE_ID');
    if (aid) params.set('aid', aid);
    return `https://www.booking.com/searchresults.fr.html?${params.toString()}`;
  }

  private airbnbUrl(o: { where: string; checkin: string | null; checkout: string | null; adults: number; kids: number[]; maxPerNight: number }) {
    const params = new URLSearchParams({
      adults: String(o.adults),
      children: String(o.kids.filter((a) => a >= 2).length),
      infants: String(o.kids.filter((a) => a < 2).length),
    });
    if (o.checkin) params.set('checkin', o.checkin);
    if (o.checkout) params.set('checkout', o.checkout);
    if (o.maxPerNight > 0) params.set('price_max', String(o.maxPerNight));
    return `https://www.airbnb.fr/s/${encodeURIComponent(o.where)}/homes?${params.toString()}`;
  }

  private flightsUrl(from: string | undefined, to: string, out: string | null, back: string | null, adults: number, kids: number) {
    const who = kids ? ` pour ${adults} adultes et ${kids} enfants` : adults > 1 ? ` pour ${adults} adultes` : '';
    const q = `Vols${from ? ` de ${from}` : ''} vers ${to}${out ? ` le ${out}` : ''}${back ? ` retour le ${back}` : ''}${who}`;
    return `https://www.google.com/travel/flights?hl=fr&q=${encodeURIComponent(q)}`;
  }

  // ---------------------------------------------------------------------------

  private parseDay(value?: string | null): string | null {
    if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
    return value.slice(0, 10);
  }

  private addDays(day: string, n: number): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  private frDate(day: string): string {
    return new Date(`${day}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }
}
