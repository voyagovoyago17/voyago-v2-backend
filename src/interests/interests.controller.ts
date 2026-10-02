import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

const INTERESTS = [
  { id: 'culture', title: 'Culture & Histoire', emoji: '🏛️', description: 'Musées, monuments, sites historiques', image_url: null },
  { id: 'gastronomie', title: 'Gastronomie', emoji: '🍜', description: 'Restaurants locaux, marchés, street food', image_url: null },
  { id: 'nature', title: 'Nature & Randonnée', emoji: '🏔️', description: 'Parcs naturels, randonnées, paysages', image_url: null },
  { id: 'plage', title: 'Plage & Mer', emoji: '🏖️', description: 'Plages, snorkeling, sports nautiques', image_url: null },
  { id: 'nightlife', title: 'Vie Nocturne', emoji: '🎉', description: 'Bars, clubs, concerts, festivals', image_url: null },
  { id: 'shopping', title: 'Shopping', emoji: '🛍️', description: 'Boutiques locales, souvenirs, marchés', image_url: null },
  { id: 'sport', title: 'Sport & Aventure', emoji: '🧗', description: 'Sports extrêmes, aventure, activités outdoor', image_url: null },
  { id: 'bien_etre', title: 'Bien-être & Spa', emoji: '🧘', description: 'Spas, yoga, relaxation', image_url: null },
  { id: 'art', title: 'Art & Design', emoji: '🎨', description: 'Galeries, street art, architecture moderne', image_url: null },
  { id: 'famille', title: 'Famille', emoji: '👨‍👩‍👧‍👦', description: "Activités pour enfants, parcs d'attraction", image_url: null },
];

@Controller()
export class InterestsController {
  @ApiTags('🎯 Intérêts & Découverte')
  @ApiOperation({ summary: 'Liste de tous les centres d’intérêt pour le swipe Tinder de voyage' })
  @Get('interests')
  getInterests() {
    return INTERESTS;
  }

  @ApiTags('🩺 Système & Santé')
  @ApiOperation({ summary: 'Vérification de l’état de santé de l’API Voyagooo' })
  @Get()
  healthCheck() {
    return { status: 'healthy', service: 'Voyagooo API', version: '2.0.0' };
  }
}
