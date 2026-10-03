import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CatalogImage, CatalogImageDocument } from '../catalog/schemas/catalog-image.schema';
import { GLOBAL_DB_CONNECTION } from '../common/constants';
import { GroundedPlace, GroundingScope, PlaceGroundingService, kmBetween, nameSimilarity } from './place-grounding.service';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';
import { POI, DayWeather } from '../trips/schemas/trip.schema';
import { GenerateTripDto } from '../trips/dto/generate-trip.dto';
import { ResponseSchema, SchemaType } from '@google/generative-ai';

const POI_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    description: { type: SchemaType.STRING },
    lat: { type: SchemaType.NUMBER },
    lng: { type: SchemaType.NUMBER },
    day: { type: SchemaType.INTEGER },
    order: { type: SchemaType.INTEGER },
    duration_minutes: { type: SchemaType.INTEGER },
    category: { type: SchemaType.STRING },
    image_query: { type: SchemaType.STRING },
    insider_tip: { type: SchemaType.STRING },
    hidden_gem: { type: SchemaType.BOOLEAN },
  },
  required: ['name', 'description', 'lat', 'lng', 'day', 'order', 'category', 'image_query', 'insider_tip'],
};

/** Pépite à collectionner : lieu secret hors itinéraire, qui motive un détour (radar). */
const GEM_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    teaser: { type: SchemaType.STRING },
    lat: { type: SchemaType.NUMBER },
    lng: { type: SchemaType.NUMBER },
    day: { type: SchemaType.INTEGER },
    category: { type: SchemaType.STRING },
    rarity: { type: SchemaType.STRING },
    image_query: { type: SchemaType.STRING },
  },
  required: ['name', 'teaser', 'lat', 'lng', 'day', 'rarity'],
};

const TRIP_POIS_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    pois: { type: SchemaType.ARRAY, items: POI_RESPONSE_SCHEMA },
    gems: { type: SchemaType.ARRAY, items: GEM_RESPONSE_SCHEMA },
  },
  required: ['pois'],
};

/** Voyage classique : les pépites sont exigées (sinon Gemini omet souvent ce champ facultatif). */
const TRIP_POIS_WITH_GEMS_RESPONSE_SCHEMA: ResponseSchema = {
  ...TRIP_POIS_RESPONSE_SCHEMA,
  required: ['pois', 'gems'],
};

/** Pépites seules (voyages existants sans pépites) */
const GEMS_ONLY_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: { gems: { type: SchemaType.ARRAY, items: GEM_RESPONSE_SCHEMA } },
  required: ['gems'],
};

/** Raretés des pépites (l'XP correspondante est fixée par le serveur, jamais par l'IA). */
export const GEM_RARITIES = ['commune', 'rare', 'legendaire'] as const;
export type GemRarity = (typeof GEM_RARITIES)[number];

export interface TripGem {
  id: string;
  name: string;
  teaser: string;
  lat: number;
  lng: number;
  day: number;
  category: string;
  rarity: GemRarity;
  image_query: string;
  image_url?: string | null;
  collected_at?: Date | null;
}

/** Nombre de pépites demandées : une par jour, 10 au maximum. */
export function expectedGemCount(durationDays: number): number {
  return Math.min(Math.max(durationDays, 1), 10);
}

/**
 * Cascade Claude (identifiants actuels, sans suffixe de date).
 * - Haiku 4.5 : rapide et économique, suffisant pour un itinéraire structuré.
 * - Sonnet 5.5 : relais plus capable ; thinking toujours actif sur ce modèle,
 *   on le garde léger avec effort "low" pour limiter latence et coût.
 */
const CLAUDE_MODELS: { id: string; effort?: 'low' | 'medium' | 'high'; extraTokens: number }[] = [
  { id: 'claude-haiku-4-5', extraTokens: 0 },
  { id: 'claude-sonnet-5-5', effort: 'low', extraTokens: 8000 },
];

/** Estimation de la sortie : ~350 tokens par lieu (description + astuce en français) + marge. */
const TOKENS_PER_POI = 350;
/** ~120 tokens par pépite (nom, accroche, coordonnées) */
const TOKENS_PER_GEM = 120;

/** Catégories de la valise (l'app associe une icône 3D à chacune) */
export const PACKING_CATEGORIES = [
  'documents',
  'argent',
  'vetements',
  'chaussures',
  'hygiene',
  'sante',
  'electronique',
  'meteo',
  'activites',
  'divers',
] as const;

export interface PackingItemDraft {
  label: string;
  essential: boolean;
  reason?: string;
}
export interface PackingCategoryDraft {
  key: (typeof PACKING_CATEGORIES)[number];
  title: string;
  items: PackingItemDraft[];
}

export interface NextDestinationDraft {
  destination: string;
  country: string;
  emoji: string;
  kind: 'meme_esprit' | 'pas_loin' | 'depaysement';
  pitch: string;
  best_season: string;
  duration_days: number;
  interests: string[];
}

const NEXT_DESTINATIONS_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    suggestions: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          destination: { type: SchemaType.STRING },
          country: { type: SchemaType.STRING },
          emoji: { type: SchemaType.STRING },
          kind: { type: SchemaType.STRING, format: 'enum', enum: ['meme_esprit', 'pas_loin', 'depaysement'] },
          pitch: { type: SchemaType.STRING },
          best_season: { type: SchemaType.STRING },
          duration_days: { type: SchemaType.INTEGER },
          interests: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        },
        required: ['destination', 'country', 'emoji', 'kind', 'pitch', 'duration_days'],
      },
    },
  },
  required: ['suggestions'],
};

export interface BookingEstimatesDraft {
  stays: {
    index: number;
    area: string;
    why: string;
    nightly_min: number;
    nightly_max: number;
    tip?: string;
    /** Autres façons de dormir sur cette étape, dont au moins une sous le plafond */
    options?: { kind: string; area: string; nightly_min: number; nightly_max: number; why: string }[];
  }[];
  activities: { name: string; price_adult: number; price_child?: number; advice?: string; priced_at?: Date; seasonal?: boolean; source?: string }[];
  local_transport?: { name: string; price_per_day: number; tip?: string };
  meals_per_person_per_day?: number;
  /** Pass touristique de la ville, à comparer aux billets à l'unité */
  city_pass?: { name: string; price_adult: number; price_child?: number; covers: string[]; tip?: string };
  /** Astuces concrètes pour dépenser moins sur place */
  money_tips?: string[];
  /** Quand réserver l'hébergement pour ces dates */
  booking_window?: string;
}

/** Hébergements : quartiers, alternatives, moment pour réserver (listes bornées : pas de boucle sans fin) */
const BOOKING_STAYS_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    stays: {
      type: SchemaType.ARRAY,
      maxItems: 8,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          index: { type: SchemaType.INTEGER },
          area: { type: SchemaType.STRING },
          why: { type: SchemaType.STRING },
          nightly_min: { type: SchemaType.NUMBER },
          nightly_max: { type: SchemaType.NUMBER },
          tip: { type: SchemaType.STRING },
          options: {
            type: SchemaType.ARRAY,
            maxItems: 3,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                kind: { type: SchemaType.STRING },
                area: { type: SchemaType.STRING },
                nightly_min: { type: SchemaType.NUMBER },
                nightly_max: { type: SchemaType.NUMBER },
                why: { type: SchemaType.STRING },
              },
              required: ['kind', 'area', 'nightly_min', 'nightly_max', 'why'],
            },
          },
        },
        required: ['index', 'area', 'why', 'nightly_min', 'nightly_max'],
      },
    },
    booking_window: { type: SchemaType.STRING },
  },
  required: ['stays'],
} as ResponseSchema;

/** Visites payantes, transports locaux, repas, pass et astuces (listes bornées) */
const BOOKING_EXTRAS_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    activities: {
      type: SchemaType.ARRAY,
      maxItems: 25,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          price_adult: { type: SchemaType.NUMBER },
          price_child: { type: SchemaType.NUMBER },
          advice: { type: SchemaType.STRING },
          peak_price_adult: { type: SchemaType.NUMBER },
          peak_months: { type: SchemaType.ARRAY, maxItems: 12, items: { type: SchemaType.INTEGER } },
        },
        required: ['name', 'price_adult'],
      },
    },
    local_transport: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        price_per_day: { type: SchemaType.NUMBER },
        tip: { type: SchemaType.STRING },
      },
      required: ['name', 'price_per_day'],
    },
    meals_per_person_per_day: { type: SchemaType.NUMBER },
    city_pass: {
      type: SchemaType.OBJECT,
      properties: {
        name: { type: SchemaType.STRING },
        price_adult: { type: SchemaType.NUMBER },
        price_child: { type: SchemaType.NUMBER },
        covers: { type: SchemaType.ARRAY, maxItems: 15, items: { type: SchemaType.STRING } },
        tip: { type: SchemaType.STRING },
      },
      required: ['name', 'price_adult', 'covers'],
    },
    money_tips: { type: SchemaType.ARRAY, maxItems: 3, items: { type: SchemaType.STRING } },
  },
  required: ['activities'],
} as ResponseSchema;

/** Réponse JSON coupée (limite de taille) : on garde tout ce qui est complet et on referme. */
export function repairTruncatedJson(text: string): any | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  const src = text.slice(start);
  const stack: string[] = [];
  const cuts: { end: number; closers: string }[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') {
      stack.pop();
      if (!stack.length) {
        try {
          return JSON.parse(src.slice(0, i + 1));
        } catch {
          return null;
        }
      }
      cuts.push({ end: i + 1, closers: [...stack].reverse().join('') });
    } else if (c === ',') {
      cuts.push({ end: i, closers: [...stack].reverse().join('') });
    }
  }
  // Du point de coupure le plus tardif au plus ancien : le premier JSON valide gagne
  for (let k = cuts.length - 1; k >= Math.max(0, cuts.length - 40); k--) {
    try {
      return JSON.parse(src.slice(0, cuts[k].end) + cuts[k].closers);
    } catch {
      // point suivant
    }
  }
  return null;
}

const PACKING_RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    categories: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          key: { type: SchemaType.STRING, format: 'enum', enum: [...PACKING_CATEGORIES] },
          title: { type: SchemaType.STRING },
          items: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                label: { type: SchemaType.STRING },
                essential: { type: SchemaType.BOOLEAN },
                reason: { type: SchemaType.STRING },
              },
              required: ['label', 'essential'],
            },
          },
        },
        required: ['key', 'title', 'items'],
      },
    },
  },
  required: ['categories'],
};
const CLAUDE_MAX_OUTPUT = 64000;

/** Schéma imposé à Claude (structured outputs) : JSON toujours valide et complet. */
const POIS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    gems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          teaser: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          day: { type: 'integer' },
          category: { type: 'string' },
          rarity: { type: 'string', enum: ['commune', 'rare', 'legendaire'] },
          image_query: { type: 'string' },
        },
        required: ['name', 'teaser', 'lat', 'lng', 'day', 'category', 'rarity', 'image_query'],
        additionalProperties: false,
      },
    },
    pois: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          lat: { type: 'number' },
          lng: { type: 'number' },
          day: { type: 'integer' },
          order: { type: 'integer' },
          duration_minutes: { type: 'integer' },
          category: { type: 'string' },
          image_query: { type: 'string' },
          insider_tip: { type: 'string' },
          hidden_gem: { type: 'boolean' },
        },
        required: [
          'name', 'description', 'lat', 'lng', 'day', 'order', 'duration_minutes',
          'category', 'image_query', 'insider_tip', 'hidden_gem',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['pois', 'gems'],
  additionalProperties: false,
};

const WEATHER_CODE_MAP: Record<number, { icon: string; summary: string }> = {
  0: { icon: '☀️', summary: 'Ensoleillé' },
  1: { icon: '⛅', summary: 'Nuageux' },
  2: { icon: '⛅', summary: 'Nuageux' },
  3: { icon: '⛅', summary: 'Nuageux' },
  45: { icon: '🌫️', summary: 'Brouillard' },
  48: { icon: '🌫️', summary: 'Brouillard' },
  51: { icon: '🌧️', summary: 'Pluvieux' },
  53: { icon: '🌧️', summary: 'Pluvieux' },
  55: { icon: '🌧️', summary: 'Pluvieux' },
  56: { icon: '🌧️', summary: 'Pluvieux' },
  57: { icon: '🌧️', summary: 'Pluvieux' },
  61: { icon: '🌧️', summary: 'Pluvieux' },
  63: { icon: '🌧️', summary: 'Pluvieux' },
  65: { icon: '🌧️', summary: 'Pluvieux' },
  66: { icon: '🌧️', summary: 'Pluvieux' },
  67: { icon: '🌧️', summary: 'Pluvieux' },
  71: { icon: '❄️', summary: 'Neigeux' },
  73: { icon: '❄️', summary: 'Neigeux' },
  75: { icon: '❄️', summary: 'Neigeux' },
  77: { icon: '❄️', summary: 'Neigeux' },
  80: { icon: '🌦️', summary: 'Averses' },
  81: { icon: '🌦️', summary: 'Averses' },
  82: { icon: '🌦️', summary: 'Averses' },
  95: { icon: '⛈️', summary: 'Orageux' },
  96: { icon: '⛈️', summary: 'Orageux' },
  99: { icon: '⛈️', summary: 'Orageux' },
};

function getWeatherInfo(code: number): { icon: string; summary: string } {
  if (WEATHER_CODE_MAP[code]) return WEATHER_CODE_MAP[code];
  if (code >= 1 && code <= 3) return { icon: '⛅', summary: 'Nuageux' };
  if (code >= 45 && code <= 48) return { icon: '🌫️', summary: 'Brouillard' };
  if (code >= 51 && code <= 67) return { icon: '🌧️', summary: 'Pluvieux' };
  if (code >= 71 && code <= 77) return { icon: '❄️', summary: 'Neigeux' };
  if (code >= 80 && code <= 82) return { icon: '🌦️', summary: 'Averses' };
  if (code >= 95 && code <= 99) return { icon: '⛈️', summary: 'Orageux' };
  return { icon: '🌡️', summary: 'Variable' };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private genAI: GoogleGenerativeAI | null = null;
  private anthropic: Anthropic | null = null;

  /** Recherches d'images en cours (une seule requête par lieu, même si plusieurs voyages la demandent) */
  private readonly imageLookups = new Map<string, Promise<string | null>>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() @InjectModel(CatalogImage.name, GLOBAL_DB_CONNECTION) private readonly imageModel?: Model<CatalogImageDocument>,
    @Optional() private readonly grounding?: PlaceGroundingService,
  ) {
    const geminiKey = this.configService.get<string>('GEMINI_API_KEY');
    if (geminiKey) {
      this.genAI = new GoogleGenerativeAI(geminiKey);
      this.logger.log('Gemini AI client initialized successfully');
    }

    // Moteur IA principal : "gemini" (défaut, offre gratuite) ou "claude" (API payante).
    // Claude reste dans le code, prêt à être réactivé via AI_PROVIDER=claude dans le .env.
    const provider = (this.configService.get<string>('AI_PROVIDER') || 'gemini').trim().toLowerCase();
    this.logger.log(`AI provider: ${provider}`);

    const anthropicKey =
      this.configService.get<string>('ANTHROPIC_API_KEY') ||
      this.configService.get<string>('CLAUDE_CODE_OAUTH_TOKEN');

    if (provider === 'claude' && anthropicKey && anthropicKey.trim().length > 0) {
      const cleanKey = anthropicKey.trim();
      try {
        if (cleanKey.startsWith('sk-ant-oat')) {
          this.anthropic = new Anthropic({
            apiKey: null,
            authToken: cleanKey,
            maxRetries: 3,
          });
          this.logger.warn(
            "Anthropic : jeton OAuth d'abonnement détecté (sk-ant-oat). Il est soumis aux quotas de l'abonnement " +
              '(erreurs 429 fréquentes). Utilise une clé API Console (sk-ant-api…) dans ANTHROPIC_API_KEY pour un backend.',
          );
        } else {
          this.anthropic = new Anthropic({
            apiKey: cleanKey,
            // Le SDK réessaie seul les 429 / 5xx en respectant l'en-tête retry-after
            maxRetries: 3,
          });
          this.logger.log('Anthropic Claude client initialized with API Key');
        }
      } catch (err) {
        this.logger.warn(`Failed to initialize Anthropic client: ${err.message}`);
      }
    }
  }

  async generatePois(dto: GenerateTripDto): Promise<POI[]> {
    return (await this.generatePoisAndGems(dto)).pois;
  }

  /**
   * Lieux de l'itinéraire et, pour un voyage classique, pépites à collectionner
   * (même appel IA : aucun coût supplémentaire). Les pépites peuvent être vides.
   */
  /**
   * Refaire une seule journée (modification d'un voyage, plan B pluie) : mêmes règles et même
   * vérification des lieux que pour un voyage complet, sans reprendre les lieux des autres jours.
   */
  async generateDayPois(dto: GenerateTripDto, opts: { day: number; avoid: string[]; indoor?: boolean }): Promise<POI[]> {
    const dayDto = { ...dto, duration_days: 1, end_date: undefined, single_day: true } as GenerateTripDto;
    const constraints = `

## CONTRAINTES DE CETTE JOURNÉE
- Une seule journée (jour 1 dans ta réponse).${opts.avoid.length ? `
- Ne reprends AUCUN de ces lieux, déjà au programme des autres jours : ${opts.avoid.slice(0, 60).join(' ; ')}.` : ''}${
      opts.indoor
        ? '\n- PLAN B PLUIE : uniquement des lieux couverts (musées, galeries, marchés couverts, cafés, ateliers, monuments à visiter à l’intérieur). Aucun parc, plage, jardin ni point de vue en plein air.'
        : ''
    }`;
    const res = await this.generatePoisAndGems(dayDto, constraints);
    return res.pois.map((p) => ({ ...p, day: opts.day }));
  }

  async generatePoisAndGems(dto: GenerateTripDto, extraContext = ''): Promise<{ pois: POI[]; gems: TripGem[] }> {
    // 0. Ancrage dans le réel : lieux réels de la destination donnés à l'IA, puis vérifiés
    const cityCoords = await this.resolveDestinationCoordinates(dto.destination);
    const scope = this.grounding ? await this.grounding.scope(dto.destination, cityCoords) : null;
    const places = scope ? await this.grounding!.candidates(scope).catch(() => [] as GroundedPlace[]) : [];
    const groundingText = (this.grounding?.promptContext(places) ?? '') + extraContext;

    let result: { pois: POI[]; gems: TripGem[] } | null = null;
    // 1. Claude, uniquement si AI_PROVIDER=claude (client non créé sinon)
    if (this.anthropic) {
      try {
        result = await this.generateWithClaude(dto, cityCoords, groundingText);
      } catch (err) {
        this.logger.warn(`Claude generation error: ${err.message}. Falling back to Gemini AI...`);
      }
    }

    // 2. Try Gemini AI (Gemini Flash & Pro models with automatic cascade)
    if (!result && this.genAI) {
      try {
        result = await this.generateWithGemini(dto, cityCoords, groundingText);
      } catch (err) {
        this.logger.warn(`Gemini generation error: ${err.message}. Using dynamic real-venue engine...`);
      }
    }

    // 3. Fallback to dynamic real-venue generation (sans pépites)
    if (!result) result = { pois: await this.generateDynamicPois(dto), gems: [] };

    return scope ? this.groundItinerary(result, dto, scope, places) : result;
  }

  /**
   * Rien d'inventé : chaque lieu et chaque pépite est vérifié (vraies coordonnées), les introuvables sont
   * retirés et remplacés par des lieux réels proches, et chaque image est celle du lieu lui-même.
   */
  private async groundItinerary(
    result: { pois: POI[]; gems: TripGem[] },
    dto: GenerateTripDto,
    scope: GroundingScope,
    places: GroundedPlace[],
  ): Promise<{ pois: POI[]; gems: TripGem[] }> {
    const g = this.grounding!;
    try {
      const { kept, dropped } = await g.verify(result.pois, scope, places);
      // Aucune note ni nombre d'avis inventé (y compris dans les lieux de secours)
      const pois: any[] = kept.map((p: any) => ({ ...p, rating: undefined, reviews_count: undefined }));

      // Remplaçants réels pour les lieux retirés, au même créneau, près des autres lieux du jour
      const replacements: any[] = [];
      for (const d of dropped as any[]) {
        const sameDay = pois.filter((p) => p.day === d.day);
        const near = sameDay.length
          ? { lat: sameDay.reduce((s, p) => s + p.lat, 0) / sameDay.length, lng: sameDay.reduce((s, p) => s + p.lng, 0) / sameDay.length }
          : scope.center;
        const used = [...pois, ...replacements].map((p) => p.name);
        const pick = g.replacements(places, used, near, d.order === 2, 1)[0];
        if (!pick) continue;
        replacements.push({
          ...d,
          name: pick.name,
          lat: pick.lat,
          lng: pick.lng,
          image_query: pick.name,
          image_url: null,
          description: '',
          insider_tip: '',
          hidden_gem: false,
          category: pick.food ? d.category : d.category,
          verified: true,
          source: pick.source,
          ...(pick.wiki ? { wiki: pick.wiki } : {}),
        });
      }
      if (replacements.length) {
        // Description tirée de Wikipédia, sinon neutre : jamais inventée
        const extracts = await g.extracts(replacements.filter((r) => r.wiki).map((r) => r.wiki));
        for (const r of replacements) {
          r.description =
            (r.wiki && extracts.get(`${r.wiki.lang}:${r.wiki.title}`)) ||
            `Lieu référencé sur la carte de ${scope.destination.split(',')[0]} : vérifie les horaires avant d'y aller.`;
        }
        pois.push(...replacements);
        this.logger.log(`${scope.destination} : ${replacements.length} lieu(x) remplacé(s) par des lieux réels`);
      }
      pois.sort((a, b) => a.day - b.day || a.order - b.order);

      const gemCheck = await g.verify(result.gems as any[], scope, places);
      const gems: any[] = gemCheck.kept;

      // Images du lieu lui-même (article Wikipédia, sinon photo géolocalisée sur place), sinon aucune
      await Promise.all(
        [...pois, ...gems].map(async (p) => {
          p.image_url = p.verified ? await g.imageFor(p).catch(() => null) : null;
        }),
      );
      return { pois, gems };
    } catch (err: any) {
      this.logger.warn(`Vérification des lieux de ${scope.destination} impossible : ${err.message}`);
      return result;
    }
  }

  /**
   * Pépites pour un voyage existant qui n'en a pas (créé avant le radar) : petit appel
   * dédié, à partir des lieux de l'itinéraire. Renvoie [] si aucune IA ne répond.
   */
  async generateGemsForItinerary(trip: {
    destination: string;
    duration_days: number;
    transports?: string[];
    pois: POI[];
  }): Promise<TripGem[]> {
    const days = Math.max(1, trip.duration_days || 1);
    const count = expectedGemCount(days);
    const dto = { destination: trip.destination, duration_days: days, purpose: 'trip' } as GenerateTripDto;
    const itinerary = Array.from({ length: days }, (_, i) => i + 1)
      .map((day) => {
        const list = trip.pois
          .filter((p) => p.day === day)
          .map((p) => `${p.name} (${Number(p.lat).toFixed(5)}, ${Number(p.lng).toFixed(5)})`)
          .join(' ; ');
        return list ? `- Jour ${day} : ${list}` : '';
      })
      .filter(Boolean)
      .join('\n');
    const transports = (trip.transports || ['marche']).join(', ');

    const prompt = `Tu es Voyago, guide local d'exception à ${trip.destination}.
Voici l'itinéraire d'un voyageur (lieux et coordonnées GPS) :
${itinerary}

Propose exactement ${count} "gems", 1 par jour (champ "day"), que le voyageur ramassera sur place pour gagner de l'XP : elles doivent donner envie de faire un détour.
- Lieux réels, secrets ou insolites (bar caché, atelier d'artisan, point de vue confidentiel, cour intérieure, street-art, librairie, marché de quartier...), ABSENTS de l'itinéraire.
- Situés à 300 m - 1 km des lieux du même jour : un vrai détour, faisable ${transports}.
- "teaser" : 1 phrase en français (20 mots max) qui intrigue sans tout dévoiler, avec un indice concret.
- "rarity" : "commune" (la plupart), "rare" (vraiment confidentiel), "legendaire" (1 seule, la plus exceptionnelle).
- "lat"/"lng" exacts du lieu (5 décimales) ; "image_query" = nom du lieu + ville.

Réponds avec UNIQUEMENT un objet JSON compact : {"gems":[{"name":"...","teaser":"...","lat":0.00000,"lng":0.00000,"day":1,"category":"bar","rarity":"commune","image_query":"..."}]}`;

    const parse = (text: string) => {
      const parsed = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
      return this.sanitizeGems(parsed.gems, trip.pois, dto);
    };

    if (this.genAI) {
      for (const modelName of ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest']) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json', responseSchema: GEMS_ONLY_RESPONSE_SCHEMA, temperature: 0.7 },
          });
          const gems = parse((await model.generateContent(prompt)).response.text());
          if (gems.length) return gems;
        } catch (err: any) {
          this.logger.warn(`Gems generation with ${modelName} failed: ${err.message}`);
        }
      }
    }
    if (this.anthropic) {
      try {
        const message = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 2000 + count * TOKENS_PER_GEM,
          messages: [{ role: 'user', content: prompt }],
        });
        const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
        if (textBlock) return parse(textBlock.text);
      } catch (err: any) {
        this.logger.warn(`Gems generation with Claude failed: ${err.message}`);
      }
    }
    return [];
  }

  /**
   * Valise sur mesure : quoi emporter pour CE voyage (climat, durée, activités, transports, pays).
   * Repli sur une liste de base si l'IA ne répond pas.
   */
  async generatePackingList(trip: {
    destination: string;
    traveler?: { gender?: string | null; age?: number | null };
    travelers?: { party: string; adults: number; children_ages: number[] } | null;
    country?: string;
    duration_days: number;
    start_date?: string;
    pace?: string;
    budget?: string;
    transports?: string[];
    interests?: string[];
    weather?: DayWeather[];
    pois?: POI[];
  }): Promise<PackingCategoryDraft[]> {
    const days = Math.max(1, trip.duration_days || 1);
    const w = (trip.weather || []).filter((d: any) => d && (d.temp_max != null || d.temp_min != null));
    const maxT = w.length ? Math.max(...w.map((d: any) => Number(d.temp_max ?? d.temp_min))) : null;
    const minT = w.length ? Math.min(...w.map((d: any) => Number(d.temp_min ?? d.temp_max))) : null;
    // Codes WMO de pluie / averses / orages (51-67, 80-82, 95-99), ou résumé explicite
    const rainy = w.filter((d: any) => {
      const code = Number(d.weather_code);
      return (code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95 || /pluie|averse|orage/i.test(d.summary ?? '');
    }).length;
    const climate = w.length
      ? `Météo prévue : de ${Math.round(minT!)}°C à ${Math.round(maxT!)}°C, ${rainy} jour(s) de pluie sur ${w.length}.`
      : 'Météo inconnue : adapte à la saison et au climat habituel de la destination.';
    const when = trip.start_date
      ? `Départ le ${new Date(trip.start_date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}.`
      : 'Dates non précisées.';
    const categories = [...new Set((trip.pois || []).map((p: any) => p.category).filter(Boolean))].slice(0, 12).join(', ');
    // Profil : affaires propres à chacun (règles, rasage, enfants...) sans rien supposer d'autre
    const gender = trip.traveler?.gender;
    const profile =
      gender === 'female'
        ? 'Titulaire du compte : une femme'
        : gender === 'male'
          ? 'Titulaire du compte : un homme'
          : 'Titulaire du compte : genre non précisé (liste neutre)';
    const age = trip.traveler?.age ? `, ${trip.traveler.age} ans` : '';
    const party = trip.travelers;
    const kids = party?.children_ages || [];
    const group = party
      ? ` · Groupe : ${party.party}, ${party.adults} adulte(s)${kids.length ? `, enfants de ${kids.join(', ')} ans` : ''}`
      : '';

    const prompt = `Tu es Voyago, expert en préparation de voyage. Prépare la valise idéale, ni trop ni trop peu.
Voyage : ${trip.destination}${trip.country ? ` (${trip.country})` : ''}, ${days} jour(s). ${when}
${climate}
Rythme : ${trip.pace || 'equilibre'} · Budget : ${trip.budget || 'moyen'} · Transports : ${(trip.transports || []).join(', ') || 'marche'}
Centres d'intérêt : ${(trip.interests || []).join(', ') || 'découverte'}${categories ? ` · Lieux prévus : ${categories}` : ''}
${profile}${age}${group}

Règles :
- 25 à 40 objets au total, en français, concrets et adaptés à CE voyage (quantités selon la durée : "5 t-shirts légers", pas "des t-shirts").
- Couvre la brosse à dents jusqu'aux vêtements : documents (passeport/CNI, visa ou e-visa si probable, assurance, billets), argent (devise locale, carte sans frais), vêtements, chaussures, hygiène, santé (trousse, médicaments utiles au pays, répulsif si zone à moustiques), électronique (adaptateur de prise du pays, batterie externe), météo (selon les températures et la pluie), activités (selon les intérêts et lieux), divers.
- "essential" = true seulement pour l'indispensable (8 à 12 objets).
- "reason" : pourquoi pour CE voyage, 8 mots max (ex : "Prises de type C au Togo").
- Personnalise selon le profil : pour une femme, ajoute en hygiène/santé les protections périodiques (serviettes, tampons, culottes ou coupe menstruelle, en quantité pour la durée) et leurs indispensables, sans jugement ni texte gênant ; pour un homme, le nécessaire de rasage ; si le genre n'est pas précisé, reste neutre.
- Groupe : prévois les quantités pour tous ; avec des enfants, ajoute une catégorie adaptée à leur âge (doudou, couches et lingettes pour les bébés, jeux et livres pour la route, gourde, chapeau et crème solaire enfant, médicaments pédiatriques, pièces d'identité des mineurs et autorisation de sortie si besoin "à vérifier").
- N'invente pas d'obligation administrative : écris "à vérifier" en cas de doute.
- "key" parmi : ${PACKING_CATEGORIES.join(', ')} ; "title" = titre court avec la bonne casse (ex : "Documents").

Réponds avec UNIQUEMENT un objet JSON : {"categories":[{"key":"documents","title":"Documents","items":[{"label":"Passeport","essential":true,"reason":"..."}]}]}`;

    const parse = (text: string) =>
      this.sanitizePacking(JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim())?.categories);

    if (this.genAI) {
      for (const modelName of ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest']) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json', responseSchema: PACKING_RESPONSE_SCHEMA, temperature: 0.4 },
          });
          const list = parse((await model.generateContent(prompt)).response.text());
          if (list.length) return list;
        } catch (err: any) {
          this.logger.warn(`Packing list with ${modelName} failed: ${err.message}`);
        }
      }
    }
    if (this.anthropic) {
      try {
        const message = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        });
        const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
        if (textBlock) {
          const list = parse(textBlock.text);
          if (list.length) return list;
        }
      } catch (err: any) {
        this.logger.warn(`Packing list with Claude failed: ${err.message}`);
      }
    }
    const base = this.defaultPackingList(days, minT, maxT, rainy > 0);
    const hygiene = base.find((c) => c.key === 'hygiene');
    if (gender === 'female' && hygiene) {
      hygiene.items.push({ label: 'Protections périodiques (pour la durée du voyage)', essential: true, reason: 'Pas toujours faciles à trouver sur place' });
    }
    if (kids.length) {
      base.push({
        key: 'divers',
        title: 'Enfants',
        items: [
          { label: 'Doudou et jeux pour la route', essential: true },
          { label: 'Médicaments pédiatriques et carnet de santé', essential: true },
          { label: "Pièces d'identité des enfants", essential: true, reason: 'Autorisation de sortie : à vérifier' },
          ...(kids.some((a) => a <= 3) ? [{ label: 'Couches et lingettes', essential: true }] : []),
        ],
      });
    }
    return base;
  }

  private sanitizePacking(raw: any): PackingCategoryDraft[] {
    if (!Array.isArray(raw)) return [];
    const byKey = new Map<string, PackingCategoryDraft>();
    for (const c of raw) {
      const key = PACKING_CATEGORIES.includes(c?.key) ? c.key : 'divers';
      const items: PackingItemDraft[] = (Array.isArray(c?.items) ? c.items : [])
        .filter((i: any) => typeof i?.label === 'string' && i.label.trim())
        .map((i: any) => ({
          label: i.label.trim().slice(0, 80),
          essential: !!i.essential,
          reason: typeof i.reason === 'string' ? i.reason.trim().slice(0, 80) : undefined,
        }));
      if (!items.length) continue;
      const existing = byKey.get(key);
      if (existing) existing.items.push(...items);
      else byKey.set(key, { key, title: String(c?.title || key).trim().slice(0, 40), items });
    }
    // Ordre logique : des papiers aux activités
    return PACKING_CATEGORIES.filter((k) => byKey.has(k)).map((k) => {
      const cat = byKey.get(k)!;
      const seen = new Set<string>();
      cat.items = cat.items.filter((i) => !seen.has(i.label.toLowerCase()) && seen.add(i.label.toLowerCase())).slice(0, 15);
      return cat;
    });
  }

  /** Liste de base, adaptée à la durée et aux températures connues. */
  private defaultPackingList(days: number, minT: number | null, maxT: number | null, rain: boolean): PackingCategoryDraft[] {
    const tops = Math.min(days, 7);
    const hot = maxT != null && maxT >= 26;
    const cold = minT != null && minT <= 8;
    return [
      { key: 'documents', title: 'Documents', items: [
        { label: "Passeport ou carte d'identité", essential: true, reason: 'Contrôles et hôtels' },
        { label: 'Billets et réservations', essential: true },
        { label: 'Assurance voyage', essential: true },
      ] },
      { key: 'argent', title: 'Argent', items: [
        { label: 'Carte bancaire', essential: true },
        { label: 'Un peu de devise locale', essential: false, reason: 'Petits achats et pourboires' },
      ] },
      { key: 'vetements', title: 'Vêtements', items: [
        { label: `${tops} hauts`, essential: true },
        { label: `${Math.max(2, Math.ceil(days / 2))} bas`, essential: false },
        { label: `${tops} sous-vêtements et paires de chaussettes`, essential: true },
        { label: 'Tenue de nuit', essential: false },
        ...(cold ? [{ label: 'Manteau chaud, bonnet et gants', essential: true, reason: `Jusqu'à ${Math.round(minT!)}°C` }] : []),
        ...(hot ? [{ label: 'Vêtements légers et respirants', essential: false, reason: `Jusqu'à ${Math.round(maxT!)}°C` }] : []),
      ] },
      { key: 'chaussures', title: 'Chaussures', items: [{ label: 'Chaussures de marche confortables', essential: true }] },
      { key: 'hygiene', title: 'Hygiène', items: [
        { label: 'Brosse à dents et dentifrice', essential: true },
        { label: 'Déodorant', essential: false },
        { label: 'Gel douche et shampoing (format voyage)', essential: false },
      ] },
      { key: 'sante', title: 'Santé', items: [
        { label: 'Médicaments personnels et ordonnances', essential: true },
        { label: 'Petite trousse de secours', essential: false },
      ] },
      { key: 'electronique', title: 'Électronique', items: [
        { label: 'Téléphone et chargeur', essential: true },
        { label: 'Batterie externe', essential: false },
        { label: 'Adaptateur de prise', essential: false, reason: 'À vérifier selon le pays' },
      ] },
      { key: 'meteo', title: 'Météo', items: [
        ...(hot ? [{ label: 'Crème solaire et lunettes de soleil', essential: true }] : []),
        ...(rain ? [{ label: 'Parapluie ou veste imperméable', essential: true, reason: 'Pluie annoncée' }] : []),
        { label: 'Gourde réutilisable', essential: false },
      ] },
    ];
  }

  /**
   * « Et maintenant ? » : 3 idées de prochain voyage à partir de ce que le voyageur a aimé
   * (lieux notés, intérêts, rythme, budget). Une même veine, une proche, un dépaysement.
   */
  async suggestNextDestinations(input: {
    destination: string;
    country?: string;
    duration_days: number;
    pace?: string;
    budget?: string;
    interests?: string[];
    loved: string[];
    disliked: string[];
    month: string;
  }): Promise<NextDestinationDraft[]> {
    const prompt = `Tu es Voyago, conseiller voyage enthousiaste et précis. Un voyageur rentre de ${input.destination}${input.country ? ` (${input.country})` : ''} (${input.duration_days} jours, rythme ${input.pace || 'equilibre'}, budget ${input.budget || 'moyen'}).
Ses centres d'intérêt : ${(input.interests || []).join(', ') || 'découverte'}.
Lieux qu'il a adorés : ${input.loved.slice(0, 8).join(', ') || 'non précisé'}.
Lieux moins appréciés : ${input.disliked.slice(0, 5).join(', ') || 'aucun'}.
Nous sommes en ${input.month}.

Propose exactement 3 prochains voyages, chacun d'un "kind" différent :
- "meme_esprit" : même ambiance que ce qu'il a adoré, dans un autre pays ;
- "pas_loin" : accessible facilement depuis la région de ${input.country || input.destination}, budget maîtrisé ;
- "depaysement" : une vraie découverte, cohérente avec ses intérêts.
Règles : jamais ${input.destination} ; destinations réelles et sûres ; "destination" = ville ou région précise ; "pitch" = 1 phrase en français (18 mots max) qui relie au voyage qu'il vient de faire ; "best_season" = meilleure période (ex : "avril à juin") ; "duration_days" entre 3 et 10 ; "interests" = 2 à 4 mots-clés en français ; "emoji" = 1 emoji évocateur.

Réponds avec UNIQUEMENT un objet JSON : {"suggestions":[{"destination":"...","country":"...","emoji":"...","kind":"meme_esprit","pitch":"...","best_season":"...","duration_days":5,"interests":["..."]}]}`;

    const parse = (text: string): NextDestinationDraft[] => {
      const raw = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim())?.suggestions;
      if (!Array.isArray(raw)) return [];
      const seen = new Set<string>();
      return raw
        .filter((r: any) => typeof r?.destination === 'string' && r.destination.trim())
        .filter((r: any) => r.destination.trim().toLowerCase() !== input.destination.trim().toLowerCase())
        .filter((r: any) => !seen.has(r.destination.toLowerCase()) && seen.add(r.destination.toLowerCase()))
        .slice(0, 3)
        .map((r: any) => ({
          destination: r.destination.trim().slice(0, 60),
          country: String(r.country || '').trim().slice(0, 60),
          emoji: String(r.emoji || '🌍').slice(0, 4),
          kind: ['meme_esprit', 'pas_loin', 'depaysement'].includes(r.kind) ? r.kind : 'depaysement',
          pitch: String(r.pitch || '').trim().slice(0, 160),
          best_season: String(r.best_season || '').trim().slice(0, 40),
          duration_days: Math.min(10, Math.max(3, Number(r.duration_days) || 5)),
          interests: Array.isArray(r.interests) ? r.interests.map(String).slice(0, 4) : [],
        }));
    };

    if (this.genAI) {
      for (const modelName of ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-flash-latest']) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json', responseSchema: NEXT_DESTINATIONS_SCHEMA, temperature: 0.8 },
          });
          const list = parse((await model.generateContent(prompt)).response.text());
          if (list.length) return list;
        } catch (err: any) {
          this.logger.warn(`Next destinations with ${modelName} failed: ${err.message}`);
        }
      }
    }
    if (this.anthropic) {
      try {
        const message = await this.anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        });
        const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
        if (textBlock) return parse(textBlock.text);
      } catch (err: any) {
        this.logger.warn(`Next destinations with Claude failed: ${err.message}`);
      }
    }
    return [];
  }

  /**
   * Réservations & Budget, partie propre au voyage : quartiers et alternatives d'hébergement selon
   * l'itinéraire, le groupe et le budget. Les visites, pass et astuces viennent du catalogue partagé.
   */
  async estimateStays(input: {
    destination: string;
    country?: string;
    level: string;
    currency: string;
    start_date?: string;
    adults: number;
    children_ages: number[];
    stays: { index: number; days: string; near: string[] }[];
    transports: string[];
    /** Plafond par nuit pour tout le groupe, tiré du budget */
    nightly_cap?: number;
  }): Promise<{ stays: BookingEstimatesDraft['stays']; booking_window?: string } | null> {
    const kids = input.children_ages.length ? `, enfants de ${input.children_ages.join(', ')} ans` : '';
    const month = input.start_date ? new Date(`${input.start_date.slice(0, 10)}T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'long' }) : null;
    const people = input.adults + input.children_ages.length;
    const context = `Voyage : ${input.destination}${input.country ? ` (${input.country})` : ''}, standing ${input.level}${input.start_date ? `, départ le ${input.start_date}` : ''}${month ? ` (saison de ${month} : tiens compte de la haute ou basse saison)` : ''}.
Voyageurs : ${input.adults} adulte(s)${kids}. Déplacements : ${input.transports.join(', ') || 'marche'}. Devise : ${input.currency}.`;
    const num = (v: any) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0);
    const uniq = <T>(list: T[], key: (x: T) => string) => {
      const seen = new Set<string>();
      return list.filter((x) => {
        const k = key(x).toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const staysPrompt = `Tu es Voyago, conseiller voyage local. Estime des prix RÉALISTES et prudents, tels qu'on les trouve en ligne.
${context}${input.nightly_cap ? `\nBudget hébergement : ${input.nightly_cap} ${input.currency} la nuit pour tout le groupe.` : ''}

Étapes (index · jours · lieux visités à proximité) :
${input.stays.slice(0, 8).map((s) => `- ${s.index} · ${s.days} · ${s.near.slice(0, 4).join(', ')}`).join('\n')}

Réponds en JSON compact :
- "stays" : UNE entrée par étape ci-dessus, pas plus. "area" (quartier réel où dormir), "why" (15 mots max : proximité, ambiance, sécurité${input.children_ages.length ? ', familles' : ''}), "nightly_min"/"nightly_max" (une nuit pour les ${people} voyageurs, chambres adaptées, standing ${input.level}), "tip" (12 mots max), "options" : EXACTEMENT 3 autres façons de dormir (pension, appartement, auberge en chambre privée, hôtel 3★…), chacune "kind" (4 mots max), "area", "nightly_min", "nightly_max", "why" (12 mots max : ce qu'on gagne, ce qu'on sacrifie).${input.nightly_cap ? ` Au moins 2 options SOUS ${input.nightly_cap} ${input.currency}.` : ''}
- "booking_window" : quand réserver pour ces dates (14 mots max).
N'invente ni remise ni partenariat. Uniquement le JSON, sans répétition.`;

    const parseStays = (raw: any) => {
      if (!raw || !Array.isArray(raw.stays)) return null;
      const stays = uniq(
        raw.stays.filter((s: any) => typeof s?.area === 'string'),
        (s: any) => String(s.index),
      )
        .slice(0, 8)
        .map((s: any) => ({
          index: Number(s.index) || 1,
          area: s.area.trim().slice(0, 60),
          why: String(s.why || '').trim().slice(0, 140),
          nightly_min: num(s.nightly_min),
          nightly_max: Math.max(num(s.nightly_max), num(s.nightly_min)),
          tip: s.tip ? String(s.tip).trim().slice(0, 100) : undefined,
          options: uniq(
            (Array.isArray(s.options) ? s.options : []).filter(
              (o: any) => typeof o?.kind === 'string' && typeof o?.area === 'string' && num(o.nightly_min) > 0,
            ),
            (o: any) => `${o.kind}|${o.area}`,
          )
            .slice(0, 3)
            .map((o: any) => ({
              kind: o.kind.trim().slice(0, 40),
              area: o.area.trim().slice(0, 60),
              nightly_min: num(o.nightly_min),
              nightly_max: Math.max(num(o.nightly_max), num(o.nightly_min)),
              why: String(o.why || '').trim().slice(0, 110),
            })),
        }));
      if (!stays.length) return null;
      return { stays, booking_window: raw.booking_window ? String(raw.booking_window).trim().slice(0, 120) : undefined };
    };

    return this.runBoundedJson('Booking stays', staysPrompt, BOOKING_STAYS_SCHEMA, parseStays, 2048);
  }

  /**
   * Fiche partagée d'une destination (catalogue) : prix d'entrée officiels des lieux demandés,
   * tarifs de haute saison, transport local, repas, pass touristique, astuces. Indépendante du voyageur.
   */
  async estimateDestinationExtras(input: {
    destination: string;
    country?: string;
    month: number;
    level: string;
    currency: string;
    /** Lieux à tarifer (seulement ceux absents ou périmés dans le catalogue) */
    places: string[];
    transports: string[];
    /** Faut-il aussi la fiche (transport, repas, pass, astuces) ? */
    with_destination: boolean;
  }): Promise<{
    places: { name: string; price_adult: number; price_child: number; peak_price_adult?: number; peak_months?: number[]; advice?: string }[];
    local_transport?: { name: string; price_per_day: number; tip?: string };
    meals_per_person_per_day?: number;
    city_pass?: { name: string; price_adult: number; price_child?: number; covers: string[]; tip?: string };
    money_tips?: string[];
  } | null> {
    if (!input.places.length && !input.with_destination) return { places: [] };
    const monthName = input.month ? new Date(Date.UTC(2026, input.month - 1, 15)).toLocaleDateString('fr-FR', { month: 'long' }) : null;
    const num = (v: any) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 0);
    const prompt = `Tu es Voyago, conseiller voyage local. Donne les tarifs OFFICIELS actuels, réalistes, en ${input.currency}.
Destination : ${input.destination}${input.country ? ` (${input.country})` : ''}${monthName ? `, voyage en ${monthName}` : ''}, standing ${input.level}.
${input.places.length ? `\nLieux à tarifer : ${input.places.slice(0, 25).join(' ; ')}\n` : ''}
Réponds en JSON compact :
${input.places.length ? `- "activities" : UNE entrée par lieu de la liste (nom EXACT), y compris les gratuits (price_adult 0). "price_adult", "price_child" (0 si gratuit pour les enfants), "advice" (10 mots max, ex : "Gratuit le 1er dimanche"). Si le tarif change selon la saison : "peak_price_adult" (tarif haute saison) et "peak_months" (numéros des mois concernés). Restaurants et rues : 0.\n` : ''}${input.with_destination ? `- "local_transport" : meilleur pass ou mode local (nom réel), "price_per_day" par personne, "tip".
- "meals_per_person_per_day" : budget repas par adulte et par jour, standing ${input.level}.
- "city_pass" : SEULEMENT si un vrai pass touristique existe dans cette ville : "name", "price_adult", "price_child", "covers" (lieux couverts, 15 max), "tip". Sinon omets-le.
- "money_tips" : EXACTEMENT 3 astuces locales concrètes pour dépenser moins${monthName ? ` en ${monthName}` : ''} (14 mots max chacune).
` : ''}N'invente ni remise ni partenariat. Uniquement le JSON, sans répétition.`;

    const parse = (raw: any) => {
      if (!raw || typeof raw !== 'object') return null;
      const seen = new Set<string>();
      const places = (Array.isArray(raw.activities) ? raw.activities : [])
        .filter((a: any) => typeof a?.name === 'string' && a.name.trim())
        .filter((a: any) => {
          const k = a.name.trim().toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, 25)
        .map((a: any) => ({
          name: a.name.trim().slice(0, 80),
          price_adult: num(a.price_adult),
          price_child: num(a.price_child),
          peak_price_adult: num(a.peak_price_adult) || undefined,
          peak_months: Array.isArray(a.peak_months)
            ? [...new Set<number>(a.peak_months.map((m: any) => Number(m)).filter((m: number) => m >= 1 && m <= 12))]
            : undefined,
          advice: a.advice ? String(a.advice).trim().slice(0, 90) : undefined,
        }));
      if (input.places.length && !places.length && !input.with_destination) return null;
      return {
        places,
        local_transport:
          raw.local_transport && typeof raw.local_transport.name === 'string'
            ? {
                name: raw.local_transport.name.trim().slice(0, 60),
                price_per_day: num(raw.local_transport.price_per_day),
                tip: raw.local_transport.tip ? String(raw.local_transport.tip).trim().slice(0, 100) : undefined,
              }
            : undefined,
        meals_per_person_per_day: num(raw.meals_per_person_per_day) || undefined,
        city_pass:
          raw.city_pass && typeof raw.city_pass.name === 'string' && num(raw.city_pass.price_adult) > 0 && Array.isArray(raw.city_pass.covers)
            ? {
                name: raw.city_pass.name.trim().slice(0, 60),
                price_adult: num(raw.city_pass.price_adult),
                price_child: num(raw.city_pass.price_child),
                covers: [...new Set<string>(raw.city_pass.covers.filter((c: any) => typeof c === 'string').map((c: string) => c.trim().slice(0, 80)))].slice(0, 15),
                tip: raw.city_pass.tip ? String(raw.city_pass.tip).trim().slice(0, 100) : undefined,
              }
            : undefined,
        money_tips: [...new Set<string>((Array.isArray(raw.money_tips) ? raw.money_tips : []).filter((t: any) => typeof t === 'string' && t.trim()).map((t: string) => t.trim().slice(0, 120)))].slice(0, 3),
      };
    };
    return this.runBoundedJson(`Catalogue ${input.destination}`, prompt, BOOKING_EXTRAS_SCHEMA, parse, 2048);
  }

  /**
   * Appel IA borné : réponse plafonnée en tokens, 20 s max par appel, 30 s au total.
   * Ordre : Gemini rapide → Claude Haiku → Gemini de secours. JSON coupé : réparé au lieu d'être jeté.
   */
  private async runBoundedJson<T>(
    label: string,
    prompt: string,
    schema: ResponseSchema,
    parse: (raw: any) => T | null,
    maxTokens: number,
  ): Promise<T | null> {
    const deadline = Date.now() + 30_000;
    const remaining = () => Math.min(20_000, deadline - Date.now());
    const decode = (text: string): T | null => {
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      let raw: any = null;
      try {
        raw = JSON.parse(clean);
      } catch {
        raw = repairTruncatedJson(clean);
        if (raw) this.logger.warn(`${label} : réponse coupée, partie complète conservée`);
      }
      return raw ? parse(raw) : null;
    };

    const gemini = async (modelName: string) => {
      if (!this.genAI || remaining() < 4000) return null;
      const model = this.genAI.getGenerativeModel(
        {
          model: modelName,
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.3, maxOutputTokens: maxTokens },
        },
        { timeout: remaining() },
      );
      return decode((await model.generateContent(prompt)).response.text());
    };
    const claude = async () => {
      if (!this.anthropic || remaining() < 4000) return null;
      const message = await this.anthropic.messages.create(
        { model: 'claude-haiku-4-5', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
        { timeout: remaining(), maxRetries: 0 },
      );
      const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
      return textBlock ? decode(textBlock.text) : null;
    };

    const attempts: [string, () => Promise<T | null>][] = [
      ['gemini-3.5-flash-lite', () => gemini('gemini-3.5-flash-lite')],
      ['claude-haiku-4-5', claude],
      ['gemini-flash-latest', () => gemini('gemini-flash-latest')],
    ];
    for (const [name, attempt] of attempts) {
      if (remaining() < 4000) break;
      try {
        const result = await attempt();
        if (result) return result;
      } catch (err: any) {
        this.logger.warn(`${label} with ${name} failed: ${String(err.message).slice(0, 200)}`);
      }
    }
    return null;
  }

  /** Les pépites ne sont demandées que pour un voyage classique (pas pour un vote de tribu). */
  private wantsGems(dto: GenerateTripDto): boolean {
    return dto.purpose !== 'tribe_vote' && !(dto as any).single_day;
  }

  /**
   * Garde les pépites exploitables : coordonnées réelles proches de la destination,
   * pas de doublon avec un lieu de l'itinéraire, rareté connue, 1 légendaire maximum.
   */
  private sanitizeGems(rawGems: any[], pois: POI[], dto: GenerateTripDto): TripGem[] {
    if (!Array.isArray(rawGems) || !this.wantsGems(dto)) return [];
    const poiNames = new Set(pois.map((p) => p.name.trim().toLowerCase()));
    const ref = pois.find((p) => p.lat && p.lng);
    let legendaryUsed = false;
    const gems: TripGem[] = [];
    for (const g of rawGems) {
      const lat = typeof g?.lat === 'number' ? g.lat : parseFloat(g?.lat);
      const lng = typeof g?.lng === 'number' ? g.lng : parseFloat(g?.lng);
      const name = (g?.name || '').toString().trim();
      if (!name || !isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) continue;
      if (poiNames.has(name.toLowerCase())) continue;
      // Une pépite à plus de ~30 km de l'itinéraire est sûrement une erreur de coordonnées
      if (ref && (Math.abs(lat - ref.lat) > 0.3 || Math.abs(lng - ref.lng) > 0.3)) continue;
      let rarity: GemRarity = GEM_RARITIES.includes(g.rarity) ? g.rarity : 'commune';
      if (rarity === 'legendaire') {
        if (legendaryUsed) rarity = 'rare';
        legendaryUsed = true;
      }
      const day = Number.isInteger(g.day) && g.day >= 1 && g.day <= dto.duration_days ? g.day : (gems.length % dto.duration_days) + 1;
      gems.push({
        id: `g${gems.length}`,
        name,
        teaser: (g.teaser || '').toString().trim() || `Un secret bien gardé de ${dto.destination}.`,
        lat,
        lng,
        day,
        category: (g.category || 'pépite').toString(),
        rarity,
        image_query: (g.image_query || name).toString(),
        image_url: null,
        collected_at: null,
      });
      if (gems.length >= expectedGemCount(dto.duration_days)) break;
    }
    return gems;
  }

  getCityCoordinates(destination: string): { lat: number; lng: number } {
    const dest = destination.toLowerCase().trim();
    const cityCoords: Record<string, { lat: number; lng: number }> = {
      abidjan: { lat: 5.3600, lng: -4.0083 },
      babi: { lat: 5.3600, lng: -4.0083 },
      paris: { lat: 48.8566, lng: 2.3522 },
      tokyo: { lat: 35.6762, lng: 139.6503 },
      'new york': { lat: 40.7128, lng: -74.0060 },
      nyc: { lat: 40.7128, lng: -74.0060 },
      londres: { lat: 51.5074, lng: -0.1278 },
      london: { lat: 51.5074, lng: -0.1278 },
      londre: { lat: 51.5074, lng: -0.1278 },
      dakar: { lat: 14.7167, lng: -17.4677 },
      marrakech: { lat: 31.6295, lng: -7.9811 },
      rome: { lat: 41.9028, lng: 12.4964 },
      roma: { lat: 41.9028, lng: 12.4964 },
      barcelone: { lat: 41.3879, lng: 2.1699 },
      barcelona: { lat: 41.3879, lng: 2.1699 },
      montreal: { lat: 45.5017, lng: -73.5673 },
      bangkok: { lat: 13.7563, lng: 100.5018 },
      dubai: { lat: 25.2048, lng: 55.2708 },
      rio: { lat: -22.9068, lng: -43.1729 },
      sydney: { lat: -33.8688, lng: 151.2093 },
      berlin: { lat: 52.5200, lng: 13.4050 },
      amsterdam: { lat: 52.3676, lng: 4.9041 },
      lisbonne: { lat: 38.7223, lng: -9.1393 },
      lisbon: { lat: 38.7223, lng: -9.1393 },
    };

    for (const [key, coords] of Object.entries(cityCoords)) {
      if (dest.includes(key) || (dest.length >= 4 && key.includes(dest))) return coords;
    }
    return { lat: 5.3600, lng: -4.0083 };
  }

  async resolveDestinationCoordinates(destination: string): Promise<{ lat: number; lng: number }> {
    const dest = destination.toLowerCase().trim();
    // 1. Matched known destination
    const known = this.getCityCoordinates(dest);
    const isAbidjan = dest.includes('abidjan') || dest.includes('babi');
    if (known.lat !== 5.3600 || isAbidjan) {
      return known;
    }

    // 2. OpenStreetMap Nominatim universal geocoding for any city on earth
    try {
      const res = await axios.get('https://nominatim.openstreetmap.org/search', {
        params: { q: destination, format: 'json', limit: 1 },
        headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
        timeout: 4000,
      });
      if (res.data && res.data.length > 0) {
        const lat = parseFloat(res.data[0].lat);
        const lng = parseFloat(res.data[0].lon);
        if (!isNaN(lat) && !isNaN(lng)) {
          return { lat, lng };
        }
      }
    } catch (e) {
      this.logger.warn(`Nominatim geocoding error for ${destination}: ${e.message}`);
    }

    return known;
  }

  private getThermalSensitivityNote(sensitivity?: string): string {
    if (sensitivity === 'cold') {
      return 'Frileux / Sensible au froid (privilégier les lieux abrités, cafés chaleureux, intérieurs cosy lors des journées fraîches, et adapter les conseils vestimentaires pour prévoir des couches bien chaudes)';
    }
    if (sensitivity === 'warm') {
      return 'Chaleureux / Craint la chaleur (privilégier les lieux ombragés, espaces climatisés, parcs avec fontaines ou terrasses aérées aux heures chaudes, et vêtements légers / respirants)';
    }
    return 'Équilibré / Tempéré standard (confortable dans les conditions moyennes de saison)';
  }

  private activitiesPerDay(dto: GenerateTripDto): number {
    return dto.pace === 'tranquille' ? 3 : dto.pace === 'intensif' ? 5 : 4;
  }

  /** Budget chiffré : enveloppe par jour et par personne, adresses et activités qui la respectent. */
  private budgetContext(dto: GenerateTripDto): string {
    if (!dto.budget_amount || dto.budget_amount <= 0) return '';
    const people = Math.max(1, (dto.adults ?? 1) + (dto.children_ages?.length ?? 0));
    const perDay = Math.round(dto.budget_amount / Math.max(1, dto.duration_days));
    const perPersonDay = Math.round(perDay / people);
    const currency = dto.currency || 'EUR';
    return `
- Enveloppe annoncée : ${dto.budget_amount} ${currency} pour tout le voyage (≈ ${perDay} ${currency}/jour, ≈ ${perPersonDay} ${currency}/jour/personne, hors transport aller-retour). Choisis restaurants et activités qui tiennent dans cette enveloppe ; privilégie les lieux gratuits ou peu chers si elle est serrée, et indique dans "insider_tip" un ordre de prix quand il est utile (entrée, plat).`;
  }

  /** Composition du groupe : lieux, rythme et activités pour que chacun en profite. */
  private travelersContext(dto: GenerateTripDto): string {
    if (!dto.travel_party || dto.purpose === 'tribe_vote') return '';
    const adults = dto.adults ?? (dto.travel_party === 'solo' ? 1 : 2);
    const kids = (dto.children_ages || []).slice().sort((a, b) => a - b);
    const kidsLabel = kids.length
      ? `${kids.length} enfant${kids.length > 1 ? 's' : ''} (${kids.map((a) => (a < 1 ? 'bébé' : `${a} ans`)).join(', ')})`
      : '';
    const who =
      dto.travel_party === 'solo'
        ? 'voyage en solo'
        : dto.travel_party === 'couple'
          ? 'voyage en couple'
          : dto.travel_party === 'amis'
            ? `voyage entre amis (${adults} personnes)`
            : `voyage en famille : ${adults} adulte${adults > 1 ? 's' : ''}${kidsLabel ? ` et ${kidsLabel}` : ''}`;

    const rules: string[] = [];
    if (kids.length) {
      const youngest = kids[0];
      rules.push(
        'Chaque journée contient au moins 1 lieu pensé pour les enfants (parc, plage surveillée, aquarium, musée interactif, ferme, atelier, aire de jeux) ; les autres restent agréables pour eux.',
        'Visites plus courtes, trajets limités, pauses régulières ; pas de bar de nuit ni de lieu interdit aux mineurs.',
        "\"insider_tip\" donne une astuce famille quand c'est utile (jeu ou défi à faire sur place pour les enfants, tarif enfant, espace bébé, accès poussette).",
      );
      if (youngest <= 3) rules.push('Avec un tout-petit : lieux accessibles en poussette, fin de journée avant 18h, une pause sieste en début d\'après-midi.');
      if (kids.some((a) => a >= 12)) rules.push('Pour les ados : au moins une activité un peu sportive ou ludique (escalade, kayak, escape game, street-art).');
    } else if (dto.travel_party === 'couple') {
      rules.push('Ajoute des moments à deux : coucher de soleil, table intimiste, balade romantique.');
    } else if (dto.travel_party === 'amis') {
      rules.push('Privilégie les expériences à vivre en groupe : tables à partager, activités, vie nocturne si les intérêts s\'y prêtent.');
    } else if (dto.travel_party === 'solo') {
      rules.push('Privilégie des lieux conviviaux et sûrs pour un voyageur seul, faciles à rejoindre.');
    }
    return `
- Voyageurs : ${who}. Les centres d'intérêt restent ceux du titulaire du compte ; adapte-les pour que tout le groupe en profite.
${rules.map((r) => `  • ${r}`).join('\n')}`;
  }

  private expectedPoiCount(dto: GenerateTripDto): number {
    return dto.duration_days * this.activitiesPerDay(dto);
  }

  private buildOptimizedTripPrompt(dto: GenerateTripDto, cityCoords: { lat: number; lng: number }, groundingText = ''): string {
    const activitiesPerDay = this.activitiesPerDay(dto);
    const totalPoisCount = this.expectedPoiCount(dto);

    let dateContext = '';
    if (dto.start_date) {
      const start = new Date(dto.start_date);
      const end = dto.end_date
        ? new Date(dto.end_date)
        : new Date(start.getTime() + (dto.duration_days - 1) * 86400000);
      const options: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      };
      const startFormatted = isNaN(start.getTime())
        ? dto.start_date
        : start.toLocaleDateString('fr-FR', options);
      const endFormatted = isNaN(end.getTime())
        ? dto.end_date || ''
        : end.toLocaleDateString('fr-FR', options);

      dateContext = `
- Dates : du ${startFormatted} au ${endFormatted}. Adapte l'itinéraire aux jours réels de la semaine (fermetures hebdomadaires des musées, marchés et animations du week-end) et à la saison à ${dto.destination}.`;

      // Calendrier jour par jour : l'IA place marchés, fermetures et événements au bon jour
      if (!isNaN(start.getTime()) && dto.duration_days <= 21) {
        const days = Array.from({ length: dto.duration_days }, (_, i) => {
          const d = new Date(start.getTime() + i * 86400000);
          return `Jour ${i + 1} = ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}`;
        });
        dateContext += `
- Calendrier : ${days.join(' ; ')}. Un lieu habituellement fermé ce jour-là (ex. musée fermé le lundi) ne doit pas y être programmé ; profite des marchés du jour, des fêtes locales ou jours fériés connus à ces dates, et mentionne-les dans insider_tip.`;
      }
    } else {
      dateContext = `
- Dates : non précisées. Propose un itinéraire valable toute l'année : évite les événements datés et privilégie les lieux ouverts tous les jours ; signale dans insider_tip les jours de fermeture habituels à vérifier.`;
    }

    const paceDetails =
      dto.pace === 'tranquille'
        ? 'Tranquille (3 étapes/jour) : Visites immersives, longues pauses détente/café, flânerie privilégiée sans précipitation.'
        : dto.pace === 'intensif'
        ? 'Intensif (5 étapes/jour) : Itinéraire dynamique et exaltant, optimisé pour voir un maximum de merveilles sans temps mort.'
        : 'Équilibré (4 étapes/jour) : Le dosage idéal entre incontournables, pépites secrètes, pause gourmande et temps libre.';

    const orderSlots =
      activitiesPerDay === 3
        ? '1 = matin, 2 = déjeuner, 3 = après-midi / soirée'
        : activitiesPerDay === 5
        ? '1 = matin, 2 = déjeuner, 3 = après-midi, 4 = fin d\'après-midi, 5 = soirée / nuit'
        : '1 = matin, 2 = déjeuner, 3 = après-midi, 4 = fin d\'après-midi / soirée';
    const interests = dto.interests.join(', ');
    const transports = dto.transports.join(', ');
    // Rayon d'une journée selon le moyen de transport le plus rapide choisi :
    // l'app affiche les temps de trajet réels entre chaque étape
    const t = dto.transports.map((m) => m.toLowerCase());
    const dayRadius = t.some((m) => /voiture|transport|metro|métro|bus|tram|bateau|taxi/.test(m))
      ? '6 km (20-25 min de trajet maximum entre deux étapes)'
      : t.some((m) => /velo|vélo|bike/.test(m))
      ? '4 km (15-20 min à vélo maximum entre deux étapes)'
      : '1,5 km (15-20 min à pied maximum entre deux étapes)';
    const dayEnd = activitiesPerDay === 5 ? '21h' : '19h';
    const travelersContext = this.travelersContext(dto);
    // Voyage de tribu : les lieux sont présentés un par un au vote du groupe (swipe)
    const tribeContext =
      dto.purpose === 'tribe_vote'
        ? `

## CONTEXTE : VOTE DE TRIBU
Ces lieux seront présentés un par un à un groupe de voyageurs qui votent d'un swipe (j'y vais / bof). Les lieux les mieux votés formeront l'itinéraire final.
- ÉVENTAIL VARIÉ : mélange incontournables, pépites secrètes, adresses gourmandes, nature et panoramas, expériences à vivre ensemble, pour que chaque membre trouve ses coups de cœur.
- DÉCISION EN 3 SECONDES : chaque "description" commence par ce qui rend le lieu unique, ton enthousiaste mais factuel, sans superlatifs vides ni formule générique.
- ESPRIT DE GROUPE : privilégie des lieux qui se vivent bien à plusieurs (tables partagées, activités, panoramas) et accessibles à un groupe.`
        : '';

    // Pépites à collectionner (radar) : uniquement pour un voyage classique, même appel IA
    const gemsCount = expectedGemCount(dto.duration_days);
    const gemsSection = this.wantsGems(dto)
      ? `

## PÉPITES À COLLECTIONNER (radar de l'app)
En plus de l'itinéraire, propose exactement ${gemsCount} "gems", 1 par jour (champ "day"). Le voyageur les ramasse sur place pour gagner de l'XP : elles doivent donner envie de faire un détour.
- Lieux réels, secrets ou insolites (bar caché, atelier d'artisan, point de vue confidentiel, cour intérieure, street-art, librairie, marché de quartier...), ABSENTS de l'itinéraire.
- Situés à 300 m - 1 km des lieux du même jour : un vrai détour, faisable ${transports}.
- "teaser" : 1 phrase (20 mots max) qui intrigue sans tout dévoiler, avec un indice concret pour trouver ou vivre le lieu.
- "rarity" : "commune" (la plupart), "rare" (vraiment confidentiel), "legendaire" (1 seule sur le séjour, la plus exceptionnelle).
- "lat"/"lng" exacts du lieu (5 décimales) ; "image_query" = nom du lieu + ville.`
      : '';
    const gemsFormat = this.wantsGems(dto)
      ? `,"gems":[{"name":"...","teaser":"...","lat":0.00000,"lng":0.00000,"day":1,"category":"bar","rarity":"commune","image_query":"..."}]`
      : `,"gems":[]`;

    return `Tu es Voyago, guide local d'exception et expert en conception de voyages sur mesure.
Conçois un itinéraire authentique, géographiquement optimisé et mémorable.

## VOYAGE
- Destination : ${dto.destination} (centre approximatif : lat ${cityCoords.lat}, lng ${cityCoords.lng})${dateContext}
- Durée : ${dto.duration_days} jour(s), couvrir CHAQUE jour de 1 à ${dto.duration_days}
- Centres d'intérêt prioritaires : ${interests}
- Rythme : ${paceDetails}
- Déplacements : ${transports}
- Budget : ${dto.budget} (adapte le standing des adresses)${this.budgetContext(dto)}
- Sensibilité thermique : ${this.getThermalSensitivityNote(dto.thermal_sensitivity)}${travelersContext}${tribeContext}${gemsSection}${groundingText}

## RÈGLES
1. VOLUME : exactement ${activitiesPerDay} lieux par jour, soit ${totalPoisCount} au total. Créneaux "order" : ${orderSlots}. Le lieu order 2 est un restaurant ou une adresse gourmande.
2. ZÉRO DOUBLON : aucun lieu ne doit apparaître deux fois sur l'ensemble du séjour. Chaque jour compte exactement 1 pépite secrète ("hidden_gem": true) : un lieu réel aimé des habitants, peu connu des touristes ; false pour tous les autres.
3. MONUMENT D'OUVERTURE : le lieu jour 1 / order 1 est LE monument ou l'édifice emblématique majeur de la destination (ex : Parthénon pour Athènes, Colisée pour Rome, Basilique de Yamoussoukro pour la Côte d'Ivoire). Son "image_query" est son nom universel (ex : "Parthenon Athens").
4. LIEUX RÉELS UNIQUEMENT, ZÉRO INVENTION : chaque lieu existe réellement à ${dto.destination} et se retrouve sur une carte. N'invente JAMAIS un nom, un restaurant, un musée ou une adresse ; si tu n'es pas certain qu'un lieu existe, NE LE PROPOSE PAS et choisis un lieu notoire (monument, musée national, grand marché, cathédrale ou grande mosquée, plage, parc). C'est encore plus vrai pour les destinations moins documentées (Afrique, petites villes) : reste sur des lieux connus et vérifiables. "name" = nom officiel exact, tel qu'affiché sur Google Maps (sans ville ni description ajoutée). Les descriptions ne contiennent que des faits sûrs : pas de date, de chiffre ou d'anecdote dont tu doutes.
5. GPS EXACTS : "lat"/"lng" réels de l'entrée principale du lieu (5 décimales), jamais le centre-ville par défaut.
6. UN QUARTIER PAR JOUR : les lieux d'une même journée tiennent dans un rayon de ${dayRadius} et s'enchaînent sans retour en arrière (${transports}). Varie les ambiances d'un jour à l'autre : centre historique, quartiers artistiques et musées, nature et panoramas, vie locale et marchés.
7. PERSONNALISATION : au moins 70 % des lieux correspondent aux centres d'intérêt (${interests}). "category" reprend le centre d'intérêt correspondant.
8. TEXTES COURTS ET UTILES (en français) :
   - "description" : 2 phrases maximum (40 mots), immersives et concrètes.
   - "insider_tip" : 1 phrase (25 mots max), conseil exclusif et actionnable : plat ou boisson à commander, meilleur créneau anti-foule, spot photo, ou tenue adaptée à la météo et à la sensibilité thermique.
9. RÉALISME : "duration_minutes" = durée réelle de visite (30 à 180) ; une journée, visites et trajets compris, tient entre 9h et ${dayEnd}.

## FORMAT
Réponds avec UNIQUEMENT un objet JSON compact (sans markdown, sans texte autour), trié par jour puis par order :
{"pois":[{"name":"Nom officiel du lieu","description":"...","lat":0.00000,"lng":0.00000,"day":1,"order":1,"duration_minutes":90,"category":"culture","image_query":"English landmark name","insider_tip":"...","hidden_gem":false}]${gemsFormat}}
Avant de répondre, vérifie : ${totalPoisCount} lieux, ${activitiesPerDay} par jour, 1 pépite par jour, aucun doublon, coordonnées propres à chaque lieu.`;
  }

  private async generateWithGemini(
    dto: GenerateTripDto,
    cityCoords: { lat: number; lng: number },
    groundingText = '',
  ): Promise<{ pois: POI[]; gems: TripGem[] }> {
    const modelsToTry = [
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-flash-lite-latest',
      'gemini-flash-latest',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'gemini-pro-latest',
    ];

    const prompt = this.buildOptimizedTripPrompt(dto, cityCoords, groundingText);

    for (const modelName of modelsToTry) {
      try {
        this.logger.log(`Attempting trip generation with Gemini model: ${modelName}`);
        const model = this.genAI!.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: 'application/json',
            // Schéma imposé : JSON toujours valide, donc moins de relances vers un autre modèle
            responseSchema: this.wantsGems(dto) ? TRIP_POIS_WITH_GEMS_RESPONSE_SCHEMA : TRIP_POIS_RESPONSE_SCHEMA,
            temperature: 0.7,
          },
        });
        const result = await model.generateContent(prompt);
        const text = result.response.text();

        const jsonText = text
          .replace(/```json/g, '')
          .replace(/```/g, '')
          .trim();

        const parsed = JSON.parse(jsonText);
        if (parsed.pois && Array.isArray(parsed.pois) && parsed.pois.length > 0) {
          const pois = this.sanitizePois(parsed.pois, dto, cityCoords);
          return { pois, gems: this.sanitizeGems(parsed.gems, pois, dto) };
        }
      } catch (err) {
        this.logger.warn(`Model ${modelName} error: ${err.message}`);
        await new Promise((r) => setTimeout(r, 400));
      }
    }

    throw new Error('All Gemini models failed to produce valid POIs');
  }

  private async generateWithClaude(
    dto: GenerateTripDto,
    cityCoords: { lat: number; lng: number },
    groundingText = '',
  ): Promise<{ pois: POI[]; gems: TripGem[] }> {
    const prompt = this.buildOptimizedTripPrompt(dto, cityCoords, groundingText);

    const activitiesPerDay = dto.pace === 'tranquille' ? 3 : dto.pace === 'intensif' ? 5 : 4;
    const expectedPois = dto.duration_days * activitiesPerDay;
    const gemTokens = this.wantsGems(dto) ? expectedGemCount(dto.duration_days) * TOKENS_PER_GEM : 0;
    const baseMaxTokens = Math.max(8000, expectedPois * TOKENS_PER_POI + gemTokens + 2000);

    for (const { id: model, effort, extraTokens } of CLAUDE_MODELS) {
      const maxTokens = Math.min(CLAUDE_MAX_OUTPUT, baseMaxTokens + extraTokens);
      const startedAt = Date.now();
      try {
        this.logger.log(`Attempting trip generation with Claude model: ${model} (max_tokens ${maxTokens}, ${expectedPois} POIs attendus)`);

        // Streaming : évite les timeouts HTTP sur les longues réponses (voyages de 10+ jours).
        // Structured outputs : la réponse respecte POIS_JSON_SCHEMA, plus de JSON tronqué ou invalide.
        const message = await this.anthropic!.messages
          .stream({
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
            output_config: {
              format: { type: 'json_schema', schema: POIS_JSON_SCHEMA },
              ...(effort ? { effort } : {}),
            },
          })
          .finalMessage();

        if (message.stop_reason === 'refusal') {
          this.logger.warn(`Claude model ${model} declined the request (refusal)`);
          continue;
        }
        if (message.stop_reason === 'max_tokens') {
          // Ne devrait plus arriver avec l'estimation ci-dessus : on passe au modèle suivant plutôt que parser un JSON coupé
          this.logger.warn(`Claude model ${model} hit max_tokens (${maxTokens}), trying next model`);
          continue;
        }

        // Sur Sonnet 5.5 le premier bloc peut être un bloc "thinking" : on cherche le bloc texte
        const textBlock = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
        if (!textBlock) {
          this.logger.warn(`Claude model ${model} returned no text block`);
          continue;
        }

        const parsed = JSON.parse(textBlock.text) as { pois?: unknown[]; gems?: unknown[] };
        if (Array.isArray(parsed.pois) && parsed.pois.length > 0) {
          this.logger.log(
            `Claude model ${model} generated ${parsed.pois.length} POIs in ${((Date.now() - startedAt) / 1000).toFixed(1)}s ` +
              `(${message.usage.output_tokens} output tokens)`,
          );
          const pois = this.sanitizePois(parsed.pois, dto, cityCoords);
          return { pois, gems: this.sanitizeGems(parsed.gems as any[], pois, dto) };
        }
        this.logger.warn(`Claude model ${model} returned an empty POI list`);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
          // Inutile d'essayer les autres modèles avec la même clé : on bascule directement sur Gemini
          throw new Error(`Anthropic credentials rejected (${err.status}): ${err.message}`);
        }
        if (err instanceof Anthropic.NotFoundError) {
          this.logger.warn(`Claude model ${model} unavailable for this account (404)`);
        } else if (err instanceof Anthropic.RateLimitError) {
          this.logger.warn(`Claude model ${model} still rate limited after retries (429)`);
        } else if (err instanceof Anthropic.APIError) {
          this.logger.warn(`Claude model ${model} API error ${err.status}: ${err.message}`);
        } else if (err instanceof SyntaxError) {
          this.logger.warn(`Claude model ${model} returned invalid JSON: ${err.message}`);
        } else {
          this.logger.warn(`Claude model ${model} error: ${(err as Error).message}`);
        }
      }
    }

    throw new Error('All Claude models failed to generate valid POIs');
  }

  private sanitizePois(rawPois: any[], dto: GenerateTripDto, fallbackCoords?: { lat: number; lng: number }): POI[] {
    const coords = fallbackCoords || this.getCityCoordinates(dto.destination);
    const perDay = Math.ceil(rawPois.length / dto.duration_days);

    return rawPois.map((p, idx) => {
      const calculatedDay = typeof p.day === 'number' && p.day >= 1 && p.day <= dto.duration_days
        ? p.day
        : Math.min(dto.duration_days, Math.floor(idx / perDay) + 1);

      const calculatedOrder = typeof p.order === 'number' ? p.order : (idx % perDay) + 1;
      const cat = p.category || dto.interests[idx % dto.interests.length] || 'culture';

      return {
        name: p.name || `Étape ${idx + 1}`,
        description: p.description || `Découverte inoubliable à ${dto.destination}.`,
        lat: typeof p.lat === 'number' && p.lat !== 0 ? p.lat : parseFloat(p.lat) || (coords.lat + (idx * 0.004) - 0.008),
        lng: typeof p.lng === 'number' && p.lng !== 0 ? p.lng : parseFloat(p.lng) || (coords.lng - (idx * 0.004) + 0.008),
        day: calculatedDay,
        order: calculatedOrder,
        duration_minutes: typeof p.duration_minutes === 'number' ? p.duration_minutes : 90,
        category: cat,
        image_query: p.image_query || p.name || dto.destination,
        image_url: p.image_url || null,
        // Aucune note inventée : seules les notes des voyageurs Voyagooo sont affichées
        rating: undefined,
        reviews_count: undefined,
        insider_tip: p.insider_tip || `Conseil Voyago : arrivez tôt le matin pour savourer le lieu au calme.`,
        hidden_gem: p.hidden_gem === true,
      };
    });
  }

  private getInsiderTipForThermal(sensitivity?: string, order?: number): string {
    if (sensitivity === 'cold') {
      return order === 1
        ? 'Matinée fraîche : emportez une veste chaude ou écharpe légère pour apprécier la visite.'
        : order === 2
        ? 'Pause déjeuner cosy : réservez une table chaleureuse en intérieur pour savourer le plat du jour.'
        : 'Fin d\'après-midi : réfugiez-vous dans un salon de thé ou café chaleureux pour une pause réconfortante.';
    }
    if (sensitivity === 'warm') {
      return order === 1
        ? 'Visite matinale idéale pour profiter de la fraîcheur avant les heures chaudes.'
        : order === 2
        ? 'Déjeuner à l\'ombre : privilégiez une salle climatisée ou une terrasse bien ombragée.'
        : 'Après-midi : hydratez-vous régulièrement et privilégiez les espaces ombragés ou climatisés.';
    }
    return order === 1
      ? 'Arrivez dès l\'ouverture pour visiter dans le calme et sans file d\'attente.'
      : order === 2
      ? 'Dégustez la spécialité artisanale du chef recommandée par les locaux.'
      : 'Idéal à l\'heure dorée pour de superbes photos et une atmosphère apaisante.';
  }

  getCuratedPhoto(category: string, destination: string): string {
    const cleanDest = (destination || 'travel').trim();
    const cleanCat = (category || 'landmark').trim();
    return `https://images.unsplash.com/featured/?${encodeURIComponent(cleanDest)},${encodeURIComponent(cleanCat)}`;
  }

  private async generateDynamicPois(dto: GenerateTripDto): Promise<POI[]> {
    const dest = dto.destination.toLowerCase().trim();
    const cityCoords = await this.resolveDestinationCoordinates(dto.destination);
    const interests = dto.interests && dto.interests.length > 0 ? dto.interests : ['culture', 'gastronomie'];
    const activitiesPerDay = dto.pace === 'tranquille' ? 3 : dto.pace === 'intensif' ? 5 : 4;
    const totalPoisCount = dto.duration_days * activitiesPerDay;

    // Base exhaustive de vrais lieux réels et emblématiques par ville (19+ London, 15+ Abidjan, 12+ Paris, 7+ Tokyo, 4+ Rome, 4+ NYC, 4+ Marrakech)
    const curatedVenuesByCity: Record<string, Array<{ name: string; cat: string; desc: string; lat: number; lng: number; rating: number; reviews: number; tip: string; img: string }>> = {
      london: [
        { name: 'British Museum & Great Court', cat: 'culture', desc: 'Trésors archéologiques mondiaux sous la spectaculaire verrière de Norman Foster.', lat: 51.5194, lng: -0.1270, rating: 4.9, reviews: 18500, tip: 'Admirez la Pierre de Rosette dès l\'ouverture à 10h pour éviter l\'affluence.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Borough Market & Gourmet Stalls', cat: 'gastronomie', desc: 'Le marché culinaire historique de Londres fondé au XIIIe siècle, paradis des gourmets.', lat: 51.5055, lng: -0.0910, rating: 4.8, reviews: 14200, tip: 'Goûtez le fameux sandwich au cheddar fermier chaud de Kappacasein.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Tower of London & Crown Jewels', cat: 'culture', desc: 'Forteresse royale millénaire gardant les Joyaux de la Couronne et protégée par les Yeomen Warders.', lat: 51.5081, lng: -0.0759, rating: 4.8, reviews: 16800, tip: 'Suivez la visite guidée d\'un Beefeater pour des anecdotes royales croustillantes.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Sky Garden & Walkie Talkie', cat: 'nature', desc: 'Jardin public suspendu au 35e étage offrant une vue panoramique à 360° sur la Tamise et Londres.', lat: 51.5112, lng: -0.0836, rating: 4.8, reviews: 11900, tip: 'Réservation gratuite en ligne obligatoire. Splendide au coucher du soleil.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Tate Modern & Millenium Bridge', cat: 'art', desc: 'Ancienne centrale électrique monumentale abritant la plus grande collection d\'art moderne d\'Europe.', lat: 51.5076, lng: -0.0994, rating: 4.7, reviews: 13100, tip: 'Traversez le Millenium Bridge depuis la cathédrale Saint-Paul pour une vue imprenable.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Dishoom Covent Garden', cat: 'gastronomie', desc: 'Hommage gastronomique vibrant aux cafés iranis de Bombay des années 1960.', lat: 51.5126, lng: -0.1260, rating: 4.8, reviews: 8700, tip: 'Ne manquez pas leur légendaire House Black Daal mijoté pendant plus de 24 heures.', img: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80' },
        { name: 'Covent Garden & Apple Market', cat: 'shopping', desc: 'Piazza piétonne animée avec spectacles de rue, boutiques de créateurs et arcades historiques.', lat: 51.5117, lng: -0.1232, rating: 4.7, reviews: 9500, tip: 'Assistez aux performances d\'opéra impromptues au sous-sol des halles.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Hyde Park & Serpentine Lake', cat: 'nature', desc: 'Le plus célèbre parc royal de Londres avec la Serpentine Gallery et les jardins commémoratifs de Diana.', lat: 51.5073, lng: -0.1657, rating: 4.8, reviews: 10400, tip: 'Louez une barque à rames sur la Serpentine pour une parenthèse bucolique.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Camden Market & Regent\'s Canal', cat: 'shopping', desc: 'Épicentre de la contre-culture londonienne regorgeant de mode vintage, street food et vinyles rares.', lat: 51.5414, lng: -0.1466, rating: 4.7, reviews: 15600, tip: 'Prenez une péniche traditionnelle le long du canal jusqu\'à Little Venice.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Soho & Ronnie Scott\'s Jazz Club', cat: 'nightlife', desc: 'Le temple mythique du jazz londonien où ont joué Miles Davis et Ella Fitzgerald.', lat: 51.5133, lng: -0.1311, rating: 4.8, reviews: 6200, tip: 'Réservez une table intime en salle pour la deuxième session de minuit.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Natural History Museum', cat: 'culture', desc: 'Cathédrale de la science abritant le squelette de la baleine bleue Hope dans le grand Hintze Hall.', lat: 51.4967, lng: -0.1764, rating: 4.9, reviews: 17200, tip: 'Entrée gratuite. Empruntez l\'escalator traversant la maquette géante du globe terrestre.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Big Ben & Westminster Abbey', cat: 'culture', desc: 'Les symboles royaux et parlementaires de l\'histoire britannique au bord de la Tamise.', lat: 51.5007, lng: -0.1246, rating: 4.9, reviews: 19800, tip: 'Traversez le pont de Westminster au crépuscule pour la silhouette dorée de Big Ben illuminée.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Cathédrale Saint-Paul de Londres', cat: 'culture', desc: 'Chef-d\'œuvre classique de Christopher Wren avec son dôme majestueux dominant la City.', lat: 51.5138, lng: -0.0984, rating: 4.8, reviews: 12400, tip: 'Montez à la Galerie des Murmures pour une acoustique fascinante.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Victoria and Albert Museum (V&A)', cat: 'art', desc: 'Le plus grand musée d\'art et de design au monde avec ses galeries de haute couture et bijoux.', lat: 51.4966, lng: -0.1722, rating: 4.8, reviews: 13900, tip: 'Prenez un thé dans le premier café de musée au monde conçu par William Morris.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'The Shard & Aqua Shard', cat: 'nightlife', desc: 'Plus haut gratte-ciel du Royaume-Uni offrant un panorama éblouissant sur les méandres de la Tamise.', lat: 51.5045, lng: -0.0865, rating: 4.7, reviews: 11200, tip: 'Sirotez un cocktail signature au 31e étage face aux lumières de Londres.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Regent\'s Park & Queen Mary\'s Gardens', cat: 'nature', desc: 'Parc royal somptueux abritant plus de 12 000 rosiers et un théâtre de plein air légendaire.', lat: 51.5313, lng: -0.1570, rating: 4.8, reviews: 8900, tip: 'Poussez jusqu\'au sommet de Primrose Hill pour l\'un des plus beaux panoramas de la capitale.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Leadenhall Market & Victorian Arcades', cat: 'gastronomie', desc: 'Marché couvert d\'époque victorienne aux dorures spectaculaires, célèbre pour ses pubs d\'affaires.', lat: 51.5127, lng: -0.0834, rating: 4.7, reviews: 7600, tip: 'Les fans reconnaîtront le décor du Chemin de Traverse dans Harry Potter.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Shoreditch Street Art & Boxpark', cat: 'art', desc: 'Épicentre branché de l\'East End orné de fresques murales signées Banksy et galeries indépendantes.', lat: 51.5235, lng: -0.0768, rating: 4.7, reviews: 8100, tip: 'Découvrez les friperies vintage et les concept-stores sous les conteneurs maritimes.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Harrods & Grand Food Hall', cat: 'shopping', desc: 'Grand magasin de luxe emblématique avec sa spectaculaire rotonde Art Nouveau et ses mets raffinés.', lat: 51.4994, lng: -0.1633, rating: 4.7, reviews: 14800, tip: 'Explorez la salle des thés et des chocolats pour des coffrets de collection uniques.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Royal Observatory Greenwich & Prime Meridian', cat: 'culture', desc: 'Le berceau du temps universel (GMT) où l\'on peut poser un pied dans l\'hémisphère Est et l\'autre à l\'Ouest.', lat: 51.4769, lng: 0.0005, rating: 4.8, reviews: 9200, tip: 'Profitez de la descente du grand parc de Greenwich pour embarquer sur le clipper Cutty Sark.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Notting Hill & Portobello Road Market', cat: 'shopping', desc: 'Quartier pastel célèbre pour son marché aux antiquités et ses maisons colorées de carte postale.', lat: 51.5155, lng: -0.2057, rating: 4.7, reviews: 12300, tip: 'Venez le samedi matin pour l\'ambiance maximale et les trouvailles vintage rares.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Kew Gardens & Palm House', cat: 'nature', desc: 'Jardins botaniques royaux classés UNESCO abritant la plus grande collection de plantes vivantes au monde.', lat: 51.4787, lng: -0.2955, rating: 4.8, reviews: 11600, tip: 'La serre victorienne Palm House transporte instantanément sous les tropiques.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Brick Lane & Curry Houses', cat: 'gastronomie', desc: 'Artère vibrante de l\'East End connue pour ses curry houses bengalis et ses bagels centenaires.', lat: 51.5220, lng: -0.0716, rating: 4.7, reviews: 9800, tip: 'Goûtez le bagel au saumon fumé du Beigel Bake ouvert 24h/24 depuis 1855.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Shakespeare\'s Globe Theatre', cat: 'art', desc: 'Reconstitution fidèle du théâtre élisabéthain à ciel ouvert sur les rives de la Tamise.', lat: 51.5081, lng: -0.0972, rating: 4.8, reviews: 7400, tip: 'Assistez à une représentation debout dans la cour pour vivre le théâtre comme au XVIe siècle.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Churchill War Rooms & Bunker Souterrain', cat: 'culture', desc: 'Le QG secret de Winston Churchill préservé intact sous les rues de Westminster.', lat: 51.5021, lng: -0.1290, rating: 4.8, reviews: 10800, tip: 'Louez l\'audioguide multimédia pour revivre les moments les plus intenses du Blitz.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
      ],
      abidjan: [
        { name: 'Cathédrale Saint-Paul du Plateau', cat: 'culture', desc: 'Chef-d\'œuvre architectural moderne surplombant la lagune Ébrié avec ses vitraux monumentaux.', lat: 5.3283, lng: -4.0195, rating: 4.7, reviews: 3200, tip: 'Montez sur l\'esplanade pour une vue panoramique sur les gratte-ciels du Plateau et la lagune.', img: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/d1/La_cath%C3%A9drale_Saint-Paul_Abidjan_03.jpg/1280px-La_cath%C3%A9drale_Saint-Paul_Abidjan_03.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail' },
        { name: 'Bushman Café & Galerie d\'Art', cat: 'gastronomie', desc: 'Hôtel-galerie d\'art contemporain africain, réputé pour sa cuisine fusion ivoirienne et ses cocktails d\'exception.', lat: 5.3524, lng: -3.9765, rating: 4.8, reviews: 2800, tip: 'Installez-vous sur le toit-terrasse arboré pour déguster l\'aloco revisité et écouter du jazz.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Parc National du Banco', cat: 'nature', desc: 'Forêt tropicale primaire de 3400 hectares préservée au cœur de la ville avec sentiers sous la canopée.', lat: 5.3850, lng: -4.0530, rating: 4.6, reviews: 1900, tip: 'Louez un vélo à l\'entrée pour rejoindre l\'étang aux silures et l\'arboretum centenaire.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Marché d\'Art de Cocody & Saint-Jean', cat: 'shopping', desc: 'Marché artisanal incontournable pour les masques baoulés, poteries et tissus pagnes traditionnels.', lat: 5.3480, lng: -4.0020, rating: 4.6, reviews: 2100, tip: 'Prenez le temps d\'échanger avec les sculpteurs sur bois sur la signification des motifs traditionnels.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Grand-Bassam & Quartier France', cat: 'culture', desc: 'Ancienne capitale coloniale classée UNESCO, bordée par l\'océan Atlantique et ses galeries d\'artistes.', lat: 5.2045, lng: -3.7380, rating: 4.8, reviews: 4100, tip: 'Dégustez un poisson braisé sauce kédjenou sur la plage face aux vagues de l\'Atlantique.', img: 'https://images.unsplash.com/photo-1509439581779-6298f75bf6e5?w=800&auto=format&fit=crop&q=80' },
        { name: 'Musée des Civilisations de Côte d\'Ivoire', cat: 'culture', desc: 'Riche collection de plus de 10 000 objets royaux, parures dorées et instruments sacrés.', lat: 5.3340, lng: -4.0175, rating: 4.7, reviews: 2400, tip: 'Demandez un guide conférencier pour comprendre la cosmogonie des peuples lagunaires.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Le Toit d\'Abidjan & Sofitel Hôtel Ivoire', cat: 'nightlife', desc: 'Restaurant gastronomique panoramique perché au sommet de la tour iconique surplombant Cocody.', lat: 5.3312, lng: -3.9980, rating: 4.9, reviews: 2100, tip: 'Idéal pour contempler le coucher de soleil sur les tours du Plateau en sirotant un cocktail.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Chez Ambroise & Maquis Traditionnel', cat: 'gastronomie', desc: 'Lieu mythique de Marcory pour déguster le meilleur poulet braisé et l\'attiéké frais.', lat: 5.3050, lng: -3.9920, rating: 4.7, reviews: 3600, tip: 'Accompagnez vos grillades d\'un piment frais écrasé et de bananes plantains frites.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Jardin Botanique de Bingerville', cat: 'nature', desc: 'Ancien parc colonial de 55 hectares arboré d\'essences tropicales rares et d\'allées royales de palmiers.', lat: 5.3590, lng: -3.8890, rating: 4.6, reviews: 1800, tip: 'Promenade idéale sous les arbres centenaires pour profiter d\'un air pur et ombragé.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Sanctuaire Marial d\'Attécoubé', cat: 'culture', desc: 'Édifice religieux moderne à l\'architecture audacieuse s\'élevant au-dessus de la baie lagonaire.', lat: 5.3550, lng: -4.0380, rating: 4.7, reviews: 1900, tip: 'Lieu de sérénité totale avec vue dominante spectaculaire sur tout le nord d\'Abidjan.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Marina de Biétry & Berges Lagunaires', cat: 'nature', desc: 'Cadre reposant en bordure d\'eau avec bateaux de plaisance et terrasses aérées.', lat: 5.2760, lng: -3.9850, rating: 4.7, reviews: 2200, tip: 'Superbe adresse pour un dîner au bord de l\'eau rafraîchi par la brise marine.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Allocodrome de Cocody & Ambiance Populaire', cat: 'gastronomie', desc: 'Rassemblement gourmand convivial où les cuisinières préparent bananes et poissons à la braise.', lat: 5.3450, lng: -3.9990, rating: 4.6, reviews: 3100, tip: 'Ambiance chaleureuse et authentique en soirée sous les manguiers.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Galerie Cécile Fakhoury', cat: 'art', desc: 'Galerie de renommée internationale dédiée à la promotion de l\'art contemporain africain.', lat: 5.3500, lng: -3.9850, rating: 4.8, reviews: 1400, tip: 'Découvrez les sculptures et toiles monumentales d\'artistes ivoiriens émergents.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Palais de la Culture Bernard Binlin-Dadié', cat: 'culture', desc: 'Grand complexe culturel de Treichville accueillant concerts, pièces de théâtre et danses traditionnelles.', lat: 5.3090, lng: -4.0120, rating: 4.6, reviews: 2700, tip: 'Consultez la programmation des spectacles musicaux au bord de la lagune.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Restaurant Saakan & Cuisine Raffinée', cat: 'gastronomie', desc: 'L\'un des plus beaux restaurants gastronomiques du Plateau sublimant les saveurs africaines.', lat: 5.3270, lng: -4.0180, rating: 4.8, reviews: 1800, tip: 'Goûtez leur souris d\'agneau au kédjenou et leur soufflé au chocolat de Côte d\'Ivoire.', img: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80' },
        { name: 'Île Boulay & Pirogues Traditionnelles', cat: 'nature', desc: 'Escapade lagunaire authentique sur une île de pêcheurs accessible uniquement en pirogue.', lat: 5.3100, lng: -4.0350, rating: 4.7, reviews: 1600, tip: 'Négociez une traversée en pirogue depuis Treichville pour une aventure locale inoubliable.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Mosquée de la Riviera Golf', cat: 'culture', desc: 'Édifice religieux aux lignes contemporaines et aux jardins intérieurs paisibles.', lat: 5.3580, lng: -3.9700, rating: 4.6, reviews: 1500, tip: 'L\'architecture intérieure mérite une visite respectueuse en dehors des heures de prière.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
      ],
      paris: [
        { name: 'Musée du Louvre & Cour Carrée', cat: 'culture', desc: 'Le plus grand musée d\'art du monde abritant des chefs-d\'œuvre inestimables dans un palais royal.', lat: 48.8606, lng: 2.3376, rating: 4.9, reviews: 18200, tip: 'Entrez par le Carrousel du Louvre pour éviter la longue file sous la pyramide principale.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Tour Eiffel & Champ-de-Mars', cat: 'culture', desc: 'La Dame de Fer emblématique dominant la Seine du haut de ses 330 mètres.', lat: 48.8584, lng: 2.2945, rating: 4.8, reviews: 24000, tip: 'Montez au deuxième étage par les escaliers pour une expérience sportive et sans attente.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Musée d\'Orsay & Grande Horloge', cat: 'art', desc: 'Ancienne gare ferroviaire monumentale transformée en temple mondial de l\'impressionnisme.', lat: 48.8599, lng: 2.3265, rating: 4.9, reviews: 14500, tip: 'Montez au 5e étage : la verrière de l\'horloge géante offre un panorama exceptionnel sur la Seine.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Café de Flore & Saint-Germain', cat: 'gastronomie', desc: 'Café littéraire mythique de Saint-Germain-des-Prés, repaire d\'artistes et intellectuels depuis 1887.', lat: 48.8541, lng: 2.3328, rating: 4.8, reviews: 4200, tip: 'Dégustez leur fameux chocolat chaud à l\'ancienne servi dans son pot en argent.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Jardin des Tuileries & Grand Bassin', cat: 'nature', desc: 'Magnifique parc à la française conçu par Le Nôtre, parfait pour une balade paisible entre sculptures et fontaines.', lat: 48.8634, lng: 2.3275, rating: 4.7, reviews: 7800, tip: 'Profitez des célèbres chaises vertes inclinées au bord du grand bassin octogonal.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Sainte-Chapelle & Île de la Cité', cat: 'culture', desc: 'Joyau de l\'architecture gothique rayonnante avec ses 1113 vitraux s\'élevant vers le ciel.', lat: 48.8554, lng: 2.3450, rating: 4.9, reviews: 9900, tip: 'Visitez par temps clair en fin de matinée : la lumière à travers les vitraux est magique.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Le Comptoir du Relais', cat: 'gastronomie', desc: 'Bistronomie d\'exception d\'Yves Camdeborde au cœur du quartier de l\'Odéon.', lat: 48.8520, lng: 2.3385, rating: 4.7, reviews: 3400, tip: 'Arrivez dès 12h00 précises pour vous installer en terrasse sans réservation préalable.', img: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=800&auto=format&fit=crop&q=80' },
        { name: 'Montmartre & Sacré-Cœur', cat: 'culture', desc: 'Village perché des peintres avec ses ruelles pavées et sa vue imprenable sur Paris.', lat: 48.8867, lng: 2.3431, rating: 4.8, reviews: 16700, tip: 'Prenez la rue de l\'Abreuvoir au lever du soleil pour une atmosphère hors du temps.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Centre Pompidou & Marais', cat: 'art', desc: 'Édifice architectural avant-gardiste abritant le musée national d\'Art moderne.', lat: 48.8606, lng: 2.3522, rating: 4.7, reviews: 11200, tip: 'Prenez la chenille d\'escalators extérieurs pour un panorama sensationnel sur les toits parisiens.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Jardin du Luxembourg & Fontaine Médicis', cat: 'nature', desc: 'Jardin à l\'italienne créé pour Marie de Médicis, orné de bassins et d\'orangers centenaires.', lat: 48.8462, lng: 2.3371, rating: 4.8, reviews: 8900, tip: 'La fontaine Médicis ombragée par les platanes est le coin le plus romantique du parc.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Place des Vosges & Maison de Victor Hugo', cat: 'culture', desc: 'La plus ancienne place royale de Paris bordée d\'arcades en briques rouges.', lat: 48.8556, lng: 2.3656, rating: 4.8, reviews: 7100, tip: 'Dégustez une glace artisanale sous les arcades ombragées.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Canal Saint-Martin & Passerelles Romantiques', cat: 'nature', desc: 'Voie d\'eau bucolique ombragée de marronniers avec écluses historiques et bars bohèmes.', lat: 48.8718, lng: 2.3662, rating: 4.7, reviews: 6200, tip: 'Idéal en fin d\'après-midi pour s\'asseoir au bord de l\'eau et regarder passer les bateaux.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Septime Restaurant & Vins Naturels', cat: 'gastronomie', desc: 'Table gastronomique étoilée de Bertrand Grébaut, réputée pour sa créativité éco-responsable.', lat: 48.8532, lng: 2.3811, rating: 4.9, reviews: 4200, tip: 'Accompagnez votre menu dégustation de l\'accord vins naturels sélectionnés par le sommelier.', img: 'https://images.unsplash.com/photo-1414235077428-338989a2e8c0?w=800&auto=format&fit=crop&q=80' },
        { name: 'Atelier des Lumières', cat: 'art', desc: 'Centre d\'art numérique immersif projetant les chefs-d\'œuvre des plus grands artistes en musique.', lat: 48.8617, lng: 2.3789, rating: 4.8, reviews: 6700, tip: 'Installez-vous au milieu du hall principal pour être entièrement enveloppé par les projections.', img: 'https://images.unsplash.com/photo-1518998053901-5348d3961a04?w=800&auto=format&fit=crop&q=80' },
        { name: 'Pont Alexandre III & Rives de Seine', cat: 'nightlife', desc: 'Le pont le plus somptueux de Paris avec ses candélabres dorés et ses terrasses animées au bord de l\'eau.', lat: 48.8638, lng: 2.3134, rating: 4.8, reviews: 7300, tip: 'Venez en début de soirée pour contempler la Tour Eiffel scintillante sur l\'eau.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Le Marais & Boutiques de Créateurs', cat: 'shopping', desc: 'Quartier historique bordé d\'hôtels particuliers, de boutiques de créateurs et de galeries branchées.', lat: 48.8555, lng: 2.3654, rating: 4.8, reviews: 5100, tip: 'Flânez dans la rue des Rosiers pour le meilleur falafel de Paris.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
      ],
      tokyo: [
        { name: 'Shibuya Crossing & Shibuya Sky', cat: 'nightlife', desc: 'Observatoire panoramique à 229m d\'altitude au-dessus du croisement le plus célèbre du monde.', lat: 35.6580, lng: 139.7016, rating: 4.9, reviews: 14500, tip: 'Réservez le créneau coucher de soleil : la vue sur Tokyo avec le mont Fuji est grandiose.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Senso-ji & Nakamise-dori', cat: 'culture', desc: 'Le plus vieux temple bouddhiste de Tokyo fondé en 645 au cœur du quartier d\'Asakusa.', lat: 35.7148, lng: 139.7967, rating: 4.8, reviews: 16900, tip: 'Passez sous la grande lanterne rouge Kaminarimon pour goûter les ningyo-yaki chauds.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Meiji Jingu & Forêt Sacrée', cat: 'nature', desc: 'Sanctuaire shintoïste niché dans une forêt centenaire de 100 000 arbres au cœur de la mégapole.', lat: 35.6764, lng: 139.6993, rating: 4.8, reviews: 11200, tip: 'Écrivez votre vœu sur une tablette votive en bois (ema) sous les grands camphriers.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'TeamLab Planets TOKYO', cat: 'art', desc: 'Musée d\'art immersif numérique géant où l\'on marche pieds nus dans l\'eau et la lumière.', lat: 35.6518, lng: 139.7897, rating: 4.9, reviews: 19800, tip: 'Portez un pantalon qui peut être retroussé jusqu\'aux genoux pour la salle aquatique.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Shinjuku Gyoen National Garden', cat: 'nature', desc: 'Oasis impériale combinant jardins à la française, à l\'anglaise et traditionnel japonais.', lat: 35.6852, lng: 139.7100, rating: 4.8, reviews: 9800, tip: 'Visitez la serre tropicale et le pavillon taïwanais au bord de l\'étang.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Tsukiji Outer Market & Sushi Bar', cat: 'gastronomie', desc: 'Ruelles animées bordées de centaines d\'échoppes servant poissons ultra-frais et brochettes.', lat: 35.6655, lng: 139.7708, rating: 4.8, reviews: 13400, tip: 'Savourez une omelette japonaise tamagoyaki tiède préparée sous vos yeux.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Ginza Six & Ruelles Gourmandes', cat: 'shopping', desc: 'Temple du luxe et de l\'art de vivre tokyoïte avec jardin suspendu sur le toit.', lat: 35.6698, lng: 139.7640, rating: 4.7, reviews: 6800, tip: 'Visitez l\'étage gastronomique au sous-sol pour des pâtisseries japonaises d\'orfèvre.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Akihabara Electric Town', cat: 'shopping', desc: 'Quartier mythique de l\'électronique, des mangas et de la culture otaku dans toute sa splendeur.', lat: 35.7023, lng: 139.7745, rating: 4.7, reviews: 11400, tip: 'Explorez les étages de figurines rares et retrogaming dans les buildings à plusieurs niveaux.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Roppongi Hills & Mori Art Museum', cat: 'art', desc: 'Complexe ultramoderne avec musée d\'art contemporain au 53e étage et vue à 360° sur Tokyo.', lat: 35.6605, lng: 139.7292, rating: 4.7, reviews: 8900, tip: 'Le Sky Deck en plein air au 54e étage est l\'un des secrets les mieux gardés de Tokyo.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Ramen Street & Tokyo Station', cat: 'gastronomie', desc: 'Galerie souterraine réunissant les meilleurs maîtres ramen du Japon sous le hall monumental de Tokyo Station.', lat: 35.6812, lng: 139.7671, rating: 4.8, reviews: 7600, tip: 'Goûtez le ramen tonkotsu chez Rokurinsha avec ses œufs mollets fondants.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
      ],
      rome: [
        { name: 'Colisée & Forum Romain', cat: 'culture', desc: 'L\'amphithéâtre mythique des gladiateurs et le centre politique de la Rome antique.', lat: 41.8902, lng: 12.4922, rating: 4.9, reviews: 22000, tip: 'Entrez tôt le matin par le Forum Romain pour éviter la file du Colisée.', img: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=800&auto=format&fit=crop&q=80' },
        { name: 'Fontaine de Trevi & Ruelles Baroques', cat: 'culture', desc: 'Chef-d\'œuvre monumental baroque où la tradition invite à jeter une pièce pour revenir à Rome.', lat: 41.9009, lng: 12.4833, rating: 4.8, reviews: 21000, tip: 'Venez avant 8h30 pour contempler l\'eau turquoise dans un silence magique.', img: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=800&auto=format&fit=crop&q=80' },
        { name: 'Panthéon de Rome & Piazza della Rotonda', cat: 'culture', desc: 'Temple romain antique bimillénaire surmonté de la plus grande coupole en béton non armé au monde.', lat: 41.8986, lng: 12.4769, rating: 4.9, reviews: 17500, tip: 'Levez les yeux vers l\'oculus central à midi : le faisceau solaire illumine le marbre.', img: 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=800&auto=format&fit=crop&q=80' },
        { name: 'Trastevere & Osteria Tradizionale', cat: 'gastronomie', desc: 'Quartier pittoresque aux façades couleur ocre et trattorias familiales authentiques.', lat: 41.8890, lng: 12.4700, rating: 4.8, reviews: 11200, tip: 'Savourez une vraie pasta cacio e pepe accompagnée d\'un vin blanc des Castelli Romani.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Villa Borghese & Galerie Borghese', cat: 'art', desc: 'Parc romantique abritant un musée exceptionnel avec les sculptures du Bernin et les peintures du Caravage.', lat: 41.9142, lng: 12.4921, rating: 4.8, reviews: 9800, tip: 'Réservez impérativement en ligne, l\'accès est limité à 360 visiteurs par créneau de 2 heures.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Piazza Navona & Fontaine des Quatre-Fleuves', cat: 'art', desc: 'Place baroque grandiose ornée des fontaines magistrales du Bernin.', lat: 41.8992, lng: 12.4731, rating: 4.8, reviews: 14600, tip: 'Offrez-vous un tartufo glacé artisanal sur la place et admirez les artistes de rue.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Vatican & Chapelle Sixtine', cat: 'culture', desc: 'Le plus petit État du monde abritant les fresques de Michel-Ange et la basilique Saint-Pierre.', lat: 41.9022, lng: 12.4539, rating: 4.9, reviews: 24000, tip: 'Réservez le créneau d\'entrée matinale (7h15) pour une visite quasi privée des Musées du Vatican.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Campo de\' Fiori & Marché Matinal', cat: 'gastronomie', desc: 'Place animée accueillant chaque matin un marché coloré de fruits frais, fleurs et épices romaines.', lat: 41.8956, lng: 12.4722, rating: 4.7, reviews: 8700, tip: 'Goûtez les supplì (croquettes de riz à la mozzarella filante) au comptoir voisin.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
      ],
      'new york': [
        { name: 'Central Park & Bethesda Terrace', cat: 'nature', desc: 'Le poumon vert légendaire de Manhattan avec ses ponts en fonte et ses allées sous les ormes.', lat: 40.7829, lng: -73.9654, rating: 4.9, reviews: 26000, tip: 'Louez une barque au Loeb Boathouse pour une balade paisible sur le lac.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Metropolitan Museum of Art (The Met)', cat: 'art', desc: 'L\'un des plus grands musées du monde avec le temple égyptien de Dendour et ses collections royales.', lat: 40.7794, lng: -73.9632, rating: 4.9, reviews: 19400, tip: 'Montez sur le toit-terrasse (Cantor Rooftop) pour un verre face à la canopée de Central Park.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'High Line & Chelsea Market', cat: 'gastronomie', desc: 'Ancienne voie ferrée aérienne végétalisée reliant les galeries d\'art et les halles gourmandes.', lat: 40.7480, lng: -74.0048, rating: 4.8, reviews: 16200, tip: 'Prenez un lobster roll au Chelsea Market avant de vous promener le long de la High Line.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Top of the Rock & Rockefeller Center', cat: 'nightlife', desc: 'Panorama à 360° sur Manhattan avec vue directe imprenable sur l\'Empire State Building.', lat: 40.7587, lng: -73.9787, rating: 4.8, reviews: 15300, tip: 'Idéal au crépuscule pour voir s\'allumer simultanément des milliers de gratte-ciels.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Brooklyn Bridge & DUMBO', cat: 'culture', desc: 'Le pont suspendu iconique de 1883 offrant un panorama spectaculaire sur la skyline de Manhattan.', lat: 40.7061, lng: -73.9969, rating: 4.8, reviews: 18500, tip: 'Traversez à pied depuis Brooklyn pour la vue la plus instagrammable de New York.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'Times Square & Broadway Shows', cat: 'nightlife', desc: 'L\'intersection la plus lumineuse et énergique du monde avec ses théâtres de Broadway.', lat: 40.7580, lng: -73.9855, rating: 4.7, reviews: 22000, tip: 'Achetez des billets à prix réduit au kiosque TKTS rouge le jour même du spectacle.', img: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Statue de la Liberté & Ellis Island', cat: 'culture', desc: 'Le monument emblématique de la liberté offert par la France en 1886, gardien de la baie.', lat: 40.6892, lng: -74.0445, rating: 4.9, reviews: 21000, tip: 'Réservez le ferry de 8h30 et l\'accès au piédestal pour éviter les foules.', img: 'https://images.unsplash.com/photo-1499856871958-5b9627545d1a?w=800&auto=format&fit=crop&q=80' },
        { name: 'SoHo & Cast-Iron Architecture', cat: 'shopping', desc: 'Quartier emblématique aux façades en fonte abritant galeries d\'art et boutiques de créateurs.', lat: 40.7233, lng: -73.9985, rating: 4.7, reviews: 11600, tip: 'Explorez les cours intérieures cachées pour découvrir des concept stores confidentiels.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
      ],
      marrakech: [
        { name: 'Place Jemaa el-Fna & Médina Historique', cat: 'culture', desc: 'Cœur battant classé UNESCO avec charmeurs de serpents, conteurs, musiciens et étals d\'épices.', lat: 31.6258, lng: -7.9891, rating: 4.8, reviews: 15800, tip: 'Prenez un thé à la menthe sur une terrasse en surplomb au coucher du soleil.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Jardin Majorelle & Musée Yves Saint Laurent', cat: 'nature', desc: 'Oasis botanique d\'un bleu cobalt éclatant créée par Jacques Majorelle.', lat: 31.6418, lng: -7.9984, rating: 4.8, reviews: 14200, tip: 'Réservez votre billet en ligne à l\'avance pour le créneau de 9h00.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Palais de la Bahia & Jardins Intérieurs', cat: 'art', desc: 'Chef-d\'œuvre de l\'architecture marocaine avec ses plafonds en cèdre sculpté et patios fleuris.', lat: 31.6218, lng: -7.9818, rating: 4.7, reviews: 9800, tip: 'Admirez les zelliges raffinés et la cour d\'honneur baignée de lumière.', img: 'https://images.unsplash.com/photo-1544816155-12df9643f363?w=800&auto=format&fit=crop&q=80' },
        { name: 'Souk des Épices & Tanneries Traditionnelles', cat: 'shopping', desc: 'Labyrinthe aromatique regorgeant de safran, cumin, cuirs artisanaux et poteries.', lat: 31.6310, lng: -7.9850, rating: 4.6, reviews: 7600, tip: 'Prenez un brin de menthe fraîche lors de la traversée des tanneries.', img: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800&auto=format&fit=crop&q=80' },
        { name: 'Le Jardin Secret & Riad Historique', cat: 'nature', desc: 'Ancien riad restauré au cœur de la médina avec jardins luxuriants et fontaines murmurantes.', lat: 31.6305, lng: -7.9870, rating: 4.7, reviews: 6200, tip: 'Montez sur la tour pour un panorama unique sur la médina et l\'Atlas enneigé.', img: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=800&auto=format&fit=crop&q=80' },
        { name: 'Tombeaux Saadiens & Mausolée Royal', cat: 'culture', desc: 'Nécropole royale du XVIe siècle redécouverte en 1917, ornée de marbre de Carrare et cèdre doré.', lat: 31.6194, lng: -7.9885, rating: 4.7, reviews: 8400, tip: 'Arrivez avant 9h30 pour profiter de la salle des Douze Colonnes sans cohue.', img: 'https://images.unsplash.com/photo-1549144511-f099e773c147?w=800&auto=format&fit=crop&q=80' },
        { name: 'Café Nomad & Rooftop Gastronomique', cat: 'gastronomie', desc: 'Restaurant-terrasse tendance servant une cuisine marocaine revisitée avec vue sur la médina.', lat: 31.6272, lng: -7.9878, rating: 4.8, reviews: 5400, tip: 'Savourez leur tagine d\'agneau aux pruneaux confits accompagné d\'un jus d\'orange pressé.', img: 'https://images.unsplash.com/photo-1550966871-3ed3cdb5ed0c?w=800&auto=format&fit=crop&q=80' },
        { name: 'Hammam Mouassine & Rituel Traditionnel', cat: 'bien_etre', desc: 'Hammam traditionnel centenaire offrant gommage au savon noir et massage à l\'huile d\'argan.', lat: 31.6315, lng: -7.9912, rating: 4.8, reviews: 4800, tip: 'Réservez le forfait complet (gommage + masque au ghassoul + massage) pour une détente totale.', img: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?w=800&auto=format&fit=crop&q=80' },
      ],
    };

    // 2. Recherche de correspondance dans le catalogue (bidirectionnelle)
    let candidateVenues: Array<{ name: string; cat: string; desc: string; lat: number; lng: number; rating: number; reviews: number; tip: string; img: string }> = [];
    for (const [key, list] of Object.entries(curatedVenuesByCity)) {
      if (dest.includes(key) || (dest.length >= 4 && key.includes(dest))) {
        candidateVenues = [...list];
        break;
      }
    }

    // 3. Si la ville est hors catalogue ou a besoin de plus d'étapes uniques : Wikipedia Geosearch
    if (candidateVenues.length < totalPoisCount) {
      try {
        const url = `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${cityCoords.lat}|${cityCoords.lng}&gsradius=15000&gslimit=50&format=json`;
        const res = await axios.get(url, {
          headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
          timeout: 4000,
        });
        const wikiPlaces = res.data?.query?.geosearch || [];
        const existingNames = new Set(candidateVenues.map((v) => v.name.toLowerCase()));

        for (const wp of wikiPlaces) {
          const title = wp.title;
          if (
            !existingNames.has(title.toLowerCase()) &&
            !title.includes('List of') &&
            !title.includes('Index of') &&
            !title.includes('District') &&
            !title.includes('railway station') &&
            !title.includes('bus station')
          ) {
            const cat = interests[candidateVenues.length % interests.length] || 'culture';
            candidateVenues.push({
              name: title,
              cat,
              desc: `Lieu emblématique et patrimoine remarquable à découvrir lors de votre étape à ${dto.destination}.`,
              lat: wp.lat,
              lng: wp.lon,
              rating: Number((4.6 + (candidateVenues.length % 4) * 0.1).toFixed(1)),
              reviews: 1400 + (candidateVenues.length * 380) % 8500,
              tip: `Conseil d'initié Voyago : prévoyez environ 1h30 pour profiter pleinement de ce lieu.`,
              img: this.getCuratedPhoto(cat, dto.destination),
            });
            existingNames.add(title.toLowerCase());
          }
        }
      } catch (e) {
        this.logger.warn(`Wikipedia Geosearch fallback error for ${dto.destination}: ${e.message}`);
      }
    }

    // 4. Priorisation selon les intérêts du voyageur
    const sortedVenues = [...candidateVenues].sort((a, b) => {
      const aMatch = interests.includes(a.cat) ? 1 : 0;
      const bMatch = interests.includes(b.cat) ? 1 : 0;
      return bMatch - aMatch;
    });

    // 5. Thèmes quotidiens pour structurer un véritable voyage immersif
    const dayThemes = [
      'Cœur historique & incontournables',
      'Art, culture & ruelles bohèmes',
      'Gastronomie, marchés & parcs',
      'Panoramas, architecture & shopping',
      'Pépites secrètes & vie nocturne',
      'Échappée verte & berges',
      'Traditions & artisanat local',
    ];

    const pois: POI[] = [];
    const usedNames = new Set<string>();
    let venueIdx = 0;

    for (let day = 1; day <= dto.duration_days; day++) {
      const dayTheme = dayThemes[(day - 1) % dayThemes.length];
      for (let order = 1; order <= activitiesPerDay; order++) {
        // Trouver le prochain lieu disponible et non utilisé
        let selected: { name: string; cat: string; desc: string; lat: number; lng: number; rating: number; reviews: number; tip: string; img: string } | null = null;
        while (venueIdx < sortedVenues.length) {
          const cand = sortedVenues[venueIdx++];
          if (!usedNames.has(cand.name.toLowerCase())) {
            selected = cand;
            usedNames.add(cand.name.toLowerCase());
            break;
          }
        }

        // Si candidats épuisés, génération procédurale de découverte inédite géolocalisée
        if (!selected) {
          const cat = interests[(day + order) % interests.length] || 'culture';
          const latOffset = (day * 0.005) + (order * 0.003) - 0.008;
          const lngOffset = (day * 0.004) - (order * 0.003) + 0.006;
          const stageName = `${dayTheme} · Étape ${order} à ${dto.destination}`;

          selected = {
            name: stageName,
            cat,
            desc: `Parcours thématique dédié à la découverte des trésors locaux et de l'ambiance authentique de ${dto.destination}.`,
            lat: cityCoords.lat + latOffset,
            lng: cityCoords.lng + lngOffset,
            rating: Number((4.6 + ((day + order) % 4) * 0.1).toFixed(1)),
            reviews: 1200 + ((day * 650 + order * 320) % 7500),
            tip: this.getInsiderTipForThermal(dto.thermal_sensitivity, order),
            img: this.getCuratedPhoto(cat, dto.destination),
          };
          usedNames.add(stageName.toLowerCase());
        }

        pois.push({
          name: selected.name,
          description: selected.desc,
          lat: selected.lat,
          lng: selected.lng,
          day,
          order,
          duration_minutes: order === 2 ? 60 : 90,
          category: selected.cat,
          image_query: `${selected.name} ${dto.destination}`,
          image_url: null,
          rating: selected.rating,
          reviews_count: selected.reviews,
          insider_tip: selected.tip,
        });
      }
    }

    return pois;
  }


  /**
   * Résout DYNAMIQUEMENT par l'IA le monument, l'édifice ou le paysage emblématique
   * de n'importe quelle ville ou pays dans le monde, 100% généré sans liste statique.
   */
  async resolveCountryMonument(
    destination: string,
    country?: string,
    city?: string,
  ): Promise<{ monumentName: string; query: string; imageUrl: string }> {
    let monumentName = `${destination} Landmark`;
    let query = `${destination} landmark`;
    let cityQuery = `${city || destination} landmark`;

    // 1. Découverte 100% DYNAMIQUE par l'IA (Gemini Flash)
    if (this.genAI) {
      const modelsToTry = [
        'gemini-3.5-flash-lite',
        'gemini-3.5-flash',
        'gemini-flash-lite-latest',
        'gemini-flash-latest',
      ];

      for (const modelName of modelsToTry) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            generationConfig: { responseMimeType: 'application/json' },
          });

          const prompt = `Tu es un expert mondial en géographie, architecture et patrimoine mondial.
Pour la destination "${destination}" (Pays: "${country || ''}", Ville: "${city || ''}"):
Identifie l'édifice architectural, le monument historique ou la merveille emblématique absolue de cette ville / ce pays.
Réponds STRICTEMENT en JSON :
{
  "monument_name": "Nom officiel du monument ou édifice en français",
  "search_query": "English landmark search query for Wikimedia Commons photo search (ex: 'Parthenon Athens', 'Sacred Heart Cathedral Lome', 'Palais du Peuple Conakry')",
  "city_query": "Alternative city landmark query in English"
}`;

          const res = await model.generateContent(prompt);
          const parsed = JSON.parse(res.response.text());
          if (parsed.monument_name && parsed.search_query) {
            monumentName = parsed.monument_name;
            query = parsed.search_query;
            if (parsed.city_query) cityQuery = parsed.city_query;
            this.logger.log(
              `AI discovered monument for ${destination}: "${monumentName}" (search query: "${query}")`,
            );
            break;
          }
        } catch (err) {
          this.logger.warn(`AI monument discovery model ${modelName} error: ${err.message}`);
        }
      }
    }

    // 2. Recherche automatique et dynamique de la photo haute résolution sur Wikimedia Commons
    // Essai 1 : query précise du monument trouvée par l'IA
    let fetchedImg = await this.fetchWikipediaImage(query);

    // Essai 2 : query de la ville / édifice alternatif si non trouvé
    if (!fetchedImg && cityQuery) {
      fetchedImg = await this.fetchWikipediaImage(cityQuery);
    }

    // Essai 3 : query avec le nom officiel français
    if (!fetchedImg && monumentName) {
      fetchedImg = await this.fetchWikipediaImage(monumentName);
    }

    // Essai 4 : query générale destination
    if (!fetchedImg) {
      fetchedImg = await this.fetchWikipediaImage(`${destination} landmark`);
    }

    if (fetchedImg) {
      return {
        monumentName,
        query,
        imageUrl: fetchedImg,
      };
    }

    // Fallback dynamique haute qualité ciblé sur la destination
    return {
      monumentName,
      query,
      imageUrl: `https://images.unsplash.com/featured/?${encodeURIComponent(destination)},landmark`,
    };
  }

  /**
   * Image d'un lieu : cherchée une seule fois, stockée dans le catalogue partagé, puis servie à tous.
   * Aucune image trouvée : mémorisé aussi, nouvel essai après 7 jours.
   */
  async fetchWikipediaImage(imageQuery: string, fallbackUrl?: string): Promise<string | null> {
    const found = await this.catalogImage(imageQuery);
    return found || fallbackUrl || this.getCuratedPhoto('culture', imageQuery);
  }

  /** Image trouvée pour cette recherche, ou null : jamais d'image générique de remplacement */
  findImage(query: string): Promise<string | null> {
    return this.catalogImage(query);
  }

  private async catalogImage(query: string): Promise<string | null> {
    const key = (query || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!key) return null;
    if (!this.imageModel) return this.searchWikimediaImage(query);
    try {
      const doc: any = await this.imageModel.findOne({ key }).lean().exec();
      if (doc?.url) {
        this.imageModel.updateOne({ key }, { $inc: { hits: 1 } }).exec().catch(() => undefined);
        return doc.url;
      }
      if (doc && Date.now() - new Date(doc.checked_at).getTime() < 7 * 24 * 3600_000) return null;
    } catch {
      return this.searchWikimediaImage(query);
    }
    if (!this.imageLookups.has(key)) {
      this.imageLookups.set(
        key,
        this.searchWikimediaImage(query)
          .then(async (url) => {
            await this.imageModel!
              .updateOne({ key }, { $set: { query, url, checked_at: new Date() }, $setOnInsert: { hits: 0 } }, { upsert: true })
              .exec()
              .catch(() => undefined);
            return url;
          })
          .finally(() => this.imageLookups.delete(key)),
      );
    }
    return this.imageLookups.get(key)!;
  }

  /** Recherche en ligne (Wikimedia Commons, puis Wikipédia EN et FR) ; null si rien de trouvé */
  private async searchWikimediaImage(imageQuery: string): Promise<string | null> {
    try {
      // 1. Essai prioritaire Wikimedia Commons (Photos de monuments en haute définition)
      const commonsUrl = 'https://commons.wikimedia.org/w/api.php';
      const commonsRes = await axios.get(commonsUrl, {
        params: {
          action: 'query',
          generator: 'search',
          gsrnamespace: 6,
          gsrsearch: imageQuery,
          gsrlimit: 1,
          prop: 'imageinfo',
          iiprop: 'url',
          iiurlwidth: 1200,
          format: 'json',
        },
        headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
        timeout: 3500,
      });

      const pages = commonsRes.data?.query?.pages;
      if (pages) {
        const firstPage = Object.values(pages)[0] as any;
        const img = firstPage?.imageinfo?.[0]?.thumburl || firstPage?.imageinfo?.[0]?.url;
        if (img && typeof img === 'string' && img.startsWith('http')) {
          return img;
        }
      }
    } catch (_) {}

    try {
      // 2. Essai Wikipédia Anglais
      const searchResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
        params: {
          action: 'opensearch',
          search: imageQuery,
          limit: 1,
          format: 'json',
        },
        headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
        timeout: 3000,
      });

      const titles: string[] = searchResponse.data[1];
      if (titles && titles.length > 0) {
        const pageResponse = await axios.get('https://en.wikipedia.org/w/api.php', {
          params: {
            action: 'query',
            titles: titles[0],
            prop: 'pageimages',
            format: 'json',
            pithumbsize: 1000,
          },
          headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
          timeout: 3000,
        });

        const pages = pageResponse.data?.query?.pages;
        if (pages) {
          const page = Object.values(pages)[0] as any;
          if (page?.thumbnail?.source) {
            return page.thumbnail.source;
          }
        }
      }
    } catch (_) {}

    try {
      // 3. Essai Wikipédia Français
      const frSearch = await axios.get('https://fr.wikipedia.org/w/api.php', {
        params: {
          action: 'opensearch',
          search: imageQuery,
          limit: 1,
          format: 'json',
        },
        headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
        timeout: 3000,
      });

      const frTitles: string[] = frSearch.data[1];
      if (frTitles && frTitles.length > 0) {
        const frPage = await axios.get('https://fr.wikipedia.org/w/api.php', {
          params: {
            action: 'query',
            titles: frTitles[0],
            prop: 'pageimages',
            format: 'json',
            pithumbsize: 1000,
          },
          headers: { 'User-Agent': 'VoyagoApp/2.0 (contact@voyago.app)' },
          timeout: 3000,
        });

        const frPages = frPage.data?.query?.pages;
        if (frPages) {
          const page = Object.values(frPages)[0] as any;
          if (page?.thumbnail?.source) {
            return page.thumbnail.source;
          }
        }
      }
    } catch (_) {}

    return null;
  }

  /** Décalage horaire (minutes) d'un lieu, via Open-Meteo ; repli sur la longitude. */
  async fetchUtcOffsetMinutes(lat: number, lng: number): Promise<number> {
    try {
      const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: { latitude: lat, longitude: lng, timezone: 'auto', forecast_days: 1, daily: 'weathercode' },
        timeout: 4000,
      });
      const seconds = response.data?.utc_offset_seconds;
      if (typeof seconds === 'number') return Math.round(seconds / 60);
    } catch {
      // Repli ci-dessous
    }
    return Math.round(lng / 15) * 60;
  }

  async fetchWeather(lat: number, lng: number, durationDays: number, startDate?: string): Promise<DayWeather[]> {
    try {
      const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
        params: {
          latitude: lat,
          longitude: lng,
          daily: 'weathercode,temperature_2m_max,temperature_2m_min',
          timezone: 'auto',
          forecast_days: 16,
        },
        timeout: 5000,
      });

      const daily = response.data?.daily;
      if (!daily) return this.generateFallbackWeather(durationDays, startDate);

      const days = Math.min(durationDays, daily.time?.length || 0);
      const weather: DayWeather[] = [];
      const baseDate = startDate ? new Date(startDate) : new Date();

      for (let i = 0; i < days; i++) {
        const code = daily.weathercode[i] ?? 0;
        const info = getWeatherInfo(code);

        let dateStr = daily.time[i];
        if (startDate && !isNaN(baseDate.getTime())) {
          const d = new Date(baseDate);
          d.setDate(baseDate.getDate() + i);
          dateStr = d.toISOString().split('T')[0];
        }

        weather.push({
          date: dateStr,
          weather_code: code,
          temp_max: Math.round(daily.temperature_2m_max[i] ?? 22),
          temp_min: Math.round(daily.temperature_2m_min[i] ?? 16),
          icon: info.icon,
          summary: info.summary,
        });
      }

      return weather;
    } catch {
      return this.generateFallbackWeather(durationDays, startDate);
    }
  }

  private generateFallbackWeather(durationDays: number, startDate?: string): DayWeather[] {
    const weather: DayWeather[] = [];
    const baseDate = startDate ? new Date(startDate) : new Date();
    const validBase = isNaN(baseDate.getTime()) ? new Date() : baseDate;

    for (let i = 0; i < durationDays; i++) {
      const date = new Date(validBase);
      date.setDate(validBase.getDate() + i);
      weather.push({
        date: date.toISOString().split('T')[0],
        weather_code: 0,
        temp_max: 23,
        temp_min: 17,
        icon: '☀️',
        summary: 'Ensoleillé',
      });
    }

    return weather;
  }
}
