import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

const INTERESTS = [
  // --- Incontournables & Découverte ---
  { id: 'culture', title: 'Culture & Histoire', emoji: '🏛️', description: 'Musées, monuments emblématiques, châteaux et sites historiques', image_url: null },
  { id: 'gastronomie', title: 'Gastronomie & Terroir', emoji: '🍜', description: 'Restaurants locaux, street food réputée, marchés gourmands et spécialités', image_url: null },
  { id: 'nature', title: 'Nature & Forêts', emoji: '🌲', description: 'Parcs nationaux, forêts luxuriantes, cascades et balades au grand air', image_url: null },
  { id: 'montagne', title: 'Montagne & Sommets', emoji: '⛰️', description: 'Pics alpins, panoramas vertigineux, randonnées d’altitude et refuges perchés', image_url: null },
  { id: 'safari', title: 'Safari & Faune Sauvage', emoji: '🦁', description: 'Réserves naturelles, observation animale, grands fauves et sanctuaires protégés', image_url: null },
  { id: 'plage', title: 'Plage & Océan', emoji: '🏖️', description: 'Plages paradisiaques, criques secrètes, snorkeling et activités nautiques', image_url: null },

  // --- Gaming, Pop-Culture & Tech (pour les gamers) ---
  { id: 'gaming', title: 'Gaming & Pop-Culture', emoji: '🎮', description: 'Bars gaming / e-sport, musées du jeu vidéo, salles d’arcade rétro, boutiques manga et univers geek', image_url: null },
  { id: 'tech', title: 'Tech, VR & Futurisme', emoji: '🤖', description: 'Expériences de réalité virtuelle, quartiers high-tech, robotique et musées scientifiques', image_url: null },
  { id: 'cinema', title: 'Cinéma, Séries & Décors', emoji: '🎬', description: 'Lieux de tournage mythiques, studios de cinéma légendaires, décors de séries et festivals', image_url: null },
  { id: 'mysteres', title: 'Mystères & Légendes', emoji: '🏰', description: 'Châteaux mystérieux, catacombes, ruines antiques, légendes locales et donjons secrets', image_url: null },

  // --- Ambiances & Évasion ---
  { id: 'photo', title: 'Spots Photo & Miradors', emoji: '📸', description: 'Points de vue panoramiques, rooftops secrets, spots dorés et décors spectaculaires', image_url: null },
  { id: 'sensations', title: 'Parcs d’Attractions & Fun', emoji: '🎢', description: 'Montagnes russes, parcs à thèmes immersifs, simulateurs et sensations fortes', image_url: null },
  { id: 'nightlife', title: 'Vie Nocturne & Festivités', emoji: '🎉', description: 'Bars animés, clubs branchés, rooftops musicaux, concerts et festivals', image_url: null },
  { id: 'sport', title: 'Sport & Aventure Extrême', emoji: '🧗', description: 'Parapente, surf, escalade, canyoning, VTT et défis outdoor intenses', image_url: null },
  { id: 'roadtrip', title: 'Road Trip & Évasion', emoji: '🚐', description: 'Routes panoramiques légendaires, étapes insolites et sentiment de liberté absolue', image_url: null },
  { id: 'bien_etre', title: 'Bien-être, Spa & Yoga', emoji: '🧘', description: 'Spas thermaux, bains chauds naturels, retraites yoga, massages et détente absolue', image_url: null },
  { id: 'art', title: 'Art, Design & Street Art', emoji: '🎨', description: 'Galeries d’art contemporain, fresques urbaines géantes, ateliers d’artistes et tiers-lieux', image_url: null },
  { id: 'shopping', title: 'Shopping, Vintage & Mode', emoji: '🛍️', description: 'Boutiques de créateurs, friperies rétro, concept stores et grands marchés artisanaux', image_url: null },
  { id: 'spiritualite', title: 'Temples & Spiritualité', emoji: '⛩️', description: 'Temples séculaires, sanctuaires sacrés, jardins zen et havres de méditation', image_url: null },
  { id: 'famille', title: 'Famille & Activités Ludiques', emoji: '👨‍👩‍👧‍👦', description: 'Grands aquariums, parcs animaliers, escape games et découvertes adaptées aux enfants', image_url: null },
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
