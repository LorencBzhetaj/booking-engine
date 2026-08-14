import { Controller, Get, Query } from '@nestjs/common';
import { AvailabilityService } from './availability.service';
import { CheckAvailabilityDto } from './dto/check-availability.dto';

@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  // GET /availability?tenantId=&roomId=&checkIn=&checkOut=
  // -> { available: boolean, totalPrice?, reason? }
  @Get()
  async check(@Query() q: CheckAvailabilityDto) {
    const result = await this.availability.checkAvailability(
      q.tenantId,
      q.roomId,
      new Date(q.checkIn),
      new Date(q.checkOut),
    );

    return {
      available: result.available,
      ...(result.totalPrice !== undefined
        ? { totalPrice: result.totalPrice }
        : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }
}
