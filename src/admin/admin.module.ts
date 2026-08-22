import { Module } from '@nestjs/common';
import { BookingsModule } from '../bookings/bookings.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [BookingsModule, CloudinaryModule],
  controllers: [AdminController],
})
export class AdminModule {}
