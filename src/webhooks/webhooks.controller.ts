import {
  Controller,
  Post,
  Req,
  Headers,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';

@ApiTags('⚡ Webhooks & Intégrations')
@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @ApiOperation({ summary: 'Réception et traitement des événements Stripe en temps réel' })
  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  async stripeWebhook(
    @Req() req: any,
    @Headers('stripe-signature') signature: string,
  ) {
    // req.body is a Buffer because of express.raw() middleware applied in main.ts
    const rawBody: Buffer = req.body;
    return this.webhooksService.handleStripeWebhook(rawBody, signature);
  }
}
