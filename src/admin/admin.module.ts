import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [BookingsModule],
  controllers: [AdminController],
})
export class AdminModule {}
