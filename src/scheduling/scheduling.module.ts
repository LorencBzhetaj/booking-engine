import { Module } from '@nestjs/common';
import { ReservationExpiryService } from './reservation-expiry.service';

@Module({
  providers: [ReservationExpiryService],
  exports: [ReservationExpiryService],
})
export class SchedulingModule {}
