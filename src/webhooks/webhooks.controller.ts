import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PayPalService } from '../paypal/paypal.service';
import { BookingService } from '../bookings/bookings.service';
import { Beds24SyncService } from '../beds24/beds24-sync.service';

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly paypal: PayPalService,
    private readonly booking: BookingService,
    private readonly beds24Sync: Beds24SyncService,
  ) {}

  // POST /webhooks/paypal
  // Verifies the signature against the RAW body (see main.ts rawBody:true), then:
  //   - CHECKOUT.ORDER.APPROVED -> capture the order so it completes
  //   - CHECKOUT.ORDER.COMPLETED -> confirm the reservation (idempotent) + email
  // Returns 200 for well-formed events; 400 only on signature failure.
  @Post('paypal')
  @HttpCode(200)
  async handlePaypal(@Req() req: RawBodyRequest<Request>) {
    const webhookId = process.env.PAYPAL_WEBHOOK_ID;
    if (!webhookId) {
      throw new BadRequestException('PayPal webhook id not configured');
    }
    if (!req.rawBody) {
      throw new BadRequestException('missing raw body');
    }

    const headers = {
      transmissionId: String(req.headers['paypal-transmission-id'] ?? ''),
      transmissionTime: String(req.headers['paypal-transmission-time'] ?? ''),
      transmissionSig: String(req.headers['paypal-transmission-sig'] ?? ''),
      certUrl: String(req.headers['paypal-cert-url'] ?? ''),
      authAlgo: String(req.headers['paypal-auth-algo'] ?? ''),
    };

    const valid = await this.paypal.verifyWebhookSignature(
      headers,
      req.rawBody,
      webhookId,
    );
    if (!valid) {
      this.logger.warn('PayPal signature verification failed');
      throw new BadRequestException('invalid signature');
    }

    const event = JSON.parse(req.rawBody.toString('utf8')) as {
      event_type?: string;
      resource?: {
        id?: string;
        custom_id?: string; // present on PAYMENT.CAPTURE.* resources
        purchase_units?: { custom_id?: string }[]; // present on CHECKOUT.ORDER.* resources
      };
    };
    const type = event.event_type;

    if (type === 'CHECKOUT.ORDER.APPROVED') {
      // Payer approved — capture so the payment settles (fires PAYMENT.CAPTURE.COMPLETED).
      const orderId = event.resource?.id;
      if (orderId) {
        try {
          await this.paypal.captureOrder(orderId);
        } catch (e) {
          this.logger.error(`PayPal capture failed for order ${orderId}: ${String(e)}`);
        }
      }
    } else if (
      type === 'PAYMENT.CAPTURE.COMPLETED' ||
      type === 'CHECKOUT.ORDER.COMPLETED'
    ) {
      // Payment settled — confirm the reservation (idempotent) + email.
      const reservationId = this.extractReservationId(event.resource);
      if (reservationId) {
        const { changed } = await this.booking.confirmFromWebhook(reservationId);
        this.logger.log(`${type} reservation=${reservationId} changed=${changed}`);
      } else {
        this.logger.warn(`${type} without custom_id (reservationId)`);
      }
    } else if (type === 'PAYMENT.CAPTURE.DENIED') {
      // Payment failed — leave the reservation pending; the cron will expire it.
      const reservationId = this.extractReservationId(event.resource);
      this.logger.error(`PAYMENT.CAPTURE.DENIED reservation=${reservationId ?? 'unknown'}`);
    }

    return { received: true };
  }

  // POST /webhooks/beds24 — inbound OTA (Booking.com/Airbnb) booking via Beds24.
  // Beds24 has no HMAC signature like the payment gateway; we support an optional
  // shared-secret token (?token=...) embedded in the webhook URL configured in Beds24.
  // Always returns 200 for well-formed calls so Beds24 does not retry endlessly.
  @Post('beds24')
  @HttpCode(200)
  async handleBeds24(@Body() body: unknown, @Query('token') token?: string) {
    const secret = process.env.BEDS24_WEBHOOK_SECRET;
    if (secret && token !== secret) {
      throw new BadRequestException('invalid webhook token');
    }
    const status = await this.beds24Sync.ingestWebhookBooking(body);
    this.logger.log(`beds24 webhook -> ${status}`);
    return { received: true, status };
  }

  /** reservationId lives in custom_id — on the capture directly, or on the order's purchase_unit. */
  private extractReservationId(resource?: {
    custom_id?: string;
    purchase_units?: { custom_id?: string }[];
  }): string | undefined {
    return resource?.custom_id ?? resource?.purchase_units?.[0]?.custom_id;
  }
}
