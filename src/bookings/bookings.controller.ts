import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { BookingService } from './bookings.service';
import { CreateBookingDto } from './dto/create-booking.dto';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly booking: BookingService) {}

  // POST /bookings
  // -> 201 { reservation } | 409 { message: "room no longer available" }
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateBookingDto) {
    const reservation = await this.booking.createBooking({
      tenantId: dto.tenantId,
      roomId: dto.roomId,
      checkIn: new Date(dto.checkIn),
      checkOut: new Date(dto.checkOut),
      guestName: dto.guestName,
      guestEmail: dto.guestEmail,
    });

    return { reservation };
  }

  // POST /bookings/:id/checkout-session
  // -> { orderId, url } | 404 not found | 409 if not pending
  @Post(':id/checkout-session')
  @HttpCode(200)
  async checkoutSession(@Param('id') id: string) {
    return this.booking.createCheckoutSession(id);
  }

  // POST /bookings/:id/capture  { orderId }
  // Captures an order approved inline via the JS SDK, then confirms (idempotent).
  // -> { status, confirmed } | 404 not found
  @Post(':id/capture')
  @HttpCode(200)
  async capture(@Param('id') id: string, @Body('orderId') orderId: string) {
    return this.booking.captureReservation(id, orderId);
  }
}
