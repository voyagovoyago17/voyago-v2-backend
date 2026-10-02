import * as dns from 'node:dns';
import { exec } from 'node:child_process';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import helmet from 'helmet';
import * as express from 'express';

// Ensure DNS resolvers handle SRV records reliably for Atlas
try {
  dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
} catch {
  // Ignore if cannot set servers
}

async function bootstrap() {
  const logger = new Logger('VoyagoBootstrap');

  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    cors: false, // Handled explicitly below
  });

  // 1. Security Headers via Helmet (with cross-origin policy for mobile & web apps)
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false, // Allows Swagger UI & external images
    }),
  );

  // 2. Stripe Webhook Raw Body Parser (must be before standard JSON body parser)
  app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

  // 3. JSON & URL-Encoded Body Parsers with 50MB payload limits
  app.use((req, res, next) => {
    if (req.path === '/api/webhooks/stripe') {
      return next();
    }
    express.json({ limit: '50mb' })(req, res, next);
  });

  app.use((req, res, next) => {
    if (req.path === '/api/webhooks/stripe') {
      return next();
    }
    express.urlencoded({ extended: true, limit: '50mb' })(req, res, next);
  });

  // 3b. UploadThing Express Adapter Route Handler (https://docs.uploadthing.com/backend-adapters/express)
  try {
    const { createRouteHandler } = require('uploadthing/express');
    const { uploadRouter } = require('./upload/uploadthing.config');
    const uploadthingToken =
      process.env.UPLOADTHING_TOKEN || process.env.UPLOADTHING_SECRET;
    app.use(
      '/api/uploadthing',
      createRouteHandler({
        router: uploadRouter,
        config: uploadthingToken ? { token: uploadthingToken } : undefined,
      }),
    );
    logger.log('UploadThing Express route handler mounted on /api/uploadthing');
  } catch (err: any) {
    logger.warn(`Could not mount UploadThing express adapter: ${err.message}`);
  }

  // 4. Global API Prefix
  app.setGlobalPrefix('api');

  // 5. Enhanced Multi-Platform CORS
  app.enableCors({
    origin: (origin, callback) => {
      // Allow all origins including mobile apps, localhost, emulators
      callback(null, true);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'x-tenant-id',
    ],
    credentials: true,
  });

  // 6. Global Validation & Transformation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: false,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // 7. Swagger / OpenAPI Documentation
  const swaggerConfig = new DocumentBuilder()
    .setTitle('🦜 Voyagooo API — Documentation Officielle')
    .setDescription(`
### Bienvenue sur l'API officielle de **Voyagooo** 🦜
*L'application mobile de planification de voyage gamifiée propulsée par l'Intelligence Artificielle.*

---
### 📚 Catégories de l'API :
- 🔐 **Authentification & Profil** : Inscription, connexion, Google OAuth, invité, vérification d'email et profil.
- ✈️ **Voyages & Itinéraires IA** : Génération d'itinéraires IA (Claude & Gemini), gestion, visibilité, radar des pépites et remix.
- 👥 **Communauté & Tribus** : Fil d'actualité public, cercles / tribus privées, posts, commentaires, défis et plans partagés.
- 🏆 **Gamification & XP** : Niveaux d'explorateur, attribution d'XP, récompenses et badges.
- 📖 **Journal de Voyage** : Carnet de bord, notes souvenirs, photos et clôture de voyages.
- 🔔 **Notifications & Alertes** : Push FCM, notifications in-app et alertes d'arrivée GPS.
- ⭐ **Lieux & Avis** : Notations, avis voyageurs et étoiles agrégées sur les POIs.
- 💎 **Voyagooo Pro & Abonnements** : Formules Pro, intégration Stripe Checkout et statut premium.
- 📷 **Médias & Uploads** : Stockage UploadThing avec suppression automatique des orphelins.
- 🎯 **Intérêts & Découverte** : Catalogue des centres d'intérêt pour le swipe Tinder.
- ⚡ **Webhooks & Intégrations** : Réception en temps réel des événements de paiement Stripe.
- 🩺 **Système & Santé** : Diagnostics et monitoring de l'API.

---
**Authentification :** Cliquez sur le bouton vert **Authorize** en haut à droite pour renseigner votre jeton de session Bearer.
    `)
    .setVersion('2.0.0')
    .addTag('🔐 Authentification & Profil', 'Gestion des comptes, sessions, vérification email et profil utilisateur')
    .addTag('✈️ Voyages & Itinéraires IA', 'Génération intelligente d’itinéraires (Claude/Gemini) et radar des pépites')
    .addTag('👥 Communauté & Tribus', 'Fil d’actualité, cercles d’amis, défis et planification partagée')
    .addTag('🏆 Gamification & XP', 'Progression, points d’expérience, récompenses et badges de voyage')
    .addTag('📖 Journal de Voyage', 'Carnet de bord, souvenirs, photos et archivage de voyages')
    .addTag('🔔 Notifications & Alertes', 'Notifications push Firebase, alertes d’arrivée et historique')
    .addTag('⭐ Lieux & Avis', 'Avis, notations étoiles et retours d’expérience de voyageurs')
    .addTag('💎 Voyagooo Pro & Abonnements', 'Pass VIP, abonnements premium et paiements sécurisés Stripe')
    .addTag('📷 Médias & Uploads', 'Upload de photos de profil et médias vers UploadThing')
    .addTag('🎯 Intérêts & Découverte', 'Centres d’intérêt pour le swipe Tinder de voyage')
    .addTag('⚡ Webhooks & Intégrations', 'Points d’entrée pour les événements Stripe en temps réel')
    .addTag('🩺 Système & Santé', 'Vérification de la santé et du statut du service')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'Token',
      name: 'Authorization',
      description: 'Entrez votre session token Voyagooo (ex: sess_...)',
      in: 'header',
    })
    .addApiKey({ type: 'apiKey', name: 'x-tenant-id', in: 'header' }, 'x-tenant-id')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: '🦜 Voyagooo API — Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none', // Accordéons fermés par défaut pour une lecture propre et agréable
      filter: true, // Barre de recherche / filtre instantané d'endpoints
      tagsSorter: 'alpha',
    },
    customCss: `
      .swagger-ui .topbar { background-color: #0F1117; border-bottom: 3px solid #58CC02; padding: 12px 0; }
      .swagger-ui .info .title { color: #58CC02; font-weight: 800; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; letter-spacing: -0.5px; }
      .swagger-ui .info p { font-size: 14px; line-height: 1.6; }
      .swagger-ui .opblock-tag { font-size: 16px; font-weight: 700; border-bottom: 2px solid #eef0f3; padding: 12px 0; }
      .swagger-ui .opblock { border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 12px; border-width: 1px; }
      .swagger-ui .btn.authorize { background-color: #58CC02; color: #fff; border-color: #58CC02; border-radius: 8px; font-weight: 700; padding: 8px 16px; }
      .swagger-ui .btn.authorize svg { fill: #fff; }
      .swagger-ui .filter .operation-filter-input { border-radius: 8px; border: 1.5px solid #58CC02; padding: 8px 12px; }
    `,
  });

  // 8. Port Configuration (Port 3333 default)
  const port = parseInt(process.env.PORT || '3333', 10);
  await app.listen(port);

  logger.log(`🦜 Voyagooo Multi-Tenant API running on http://localhost:${port}/api`);
  logger.log(`📚 Swagger Documentation available on http://localhost:${port}/api/docs`);

  // 9. Auto ADB Reverse pour périphériques Android branchés en USB
  if (process.env.NODE_ENV !== 'production') {
    let lastAdbStatus = false;
    const syncAdbReverse = () => {
      const sdkAdb = process.env.LOCALAPPDATA
        ? `"${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe"`
        : 'adb';
      // Tente d'abord le chemin Android SDK, sinon le adb global
      exec(`${sdkAdb} reverse tcp:${port} tcp:${port}`, (err) => {
        if (!err) {
          if (!lastAdbStatus) {
            logger.log(`📱 ADB Reverse actif : port ${port} redirigé vers le smartphone USB`);
            lastAdbStatus = true;
          }
        } else {
          exec(`adb reverse tcp:${port} tcp:${port}`, (err2) => {
            if (!err2 && !lastAdbStatus) {
              logger.log(`📱 ADB Reverse actif : port ${port} redirigé vers le smartphone USB`);
              lastAdbStatus = true;
            } else if (err2) {
              lastAdbStatus = false;
            }
          });
        }
      });
    };
    syncAdbReverse();
    setInterval(syncAdbReverse, 8000);
  }
}

bootstrap();
