import { Module } from '@nestjs/common';
import { PayPalModule } from '../paypal/paypal.module';
import { BookingsModule } from '../bookings/bookings.module';
import { Beds24Module } from '../beds24/beds24.module';
import { WebhooksController } from './webhooks.controller';

@Module({
  imports: [PayPalModule, BookingsModule, Beds24Module],
  controllers: [WebhooksController],
})
export class WebhooksModule {}
