import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { PayPalModule } from '../paypal/paypal.module';
import { EmailModule } from '../email/email.module';
import { Beds24Module } from '../beds24/beds24.module';
import { BookingsController } from './bookings.controller';
import { BookingService } from './bookings.service';

@Module({
  imports: [AvailabilityModule, PayPalModule, EmailModule, Beds24Module],
  controllers: [BookingsController],
  providers: [BookingService],
  exports: [BookingService], // used by WebhooksModule
})
export class BookingsModule {}
