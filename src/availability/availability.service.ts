import { Injectable } from '@nestjs/common';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AvailabilityResult {
  available: boolean;
  nights?: number;
  /** Total price incl. tax, formatted with 2 decimals (e.g. "240.00"). */
  totalPrice?: string;
  /** Human-readable reason when not available. */
  reason?: string;
}

const ACTIVE_STATUSES: ReservationStatus[] = [
  ReservationStatus.pending,
  ReservationStatus.confirmed,
];
const MS_PER_DAY = 86_400_000;

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks whether a room can be booked for [checkIn, checkOut) and, if so,
   * returns the computed total price.
   *
   * NOTE: the overlap query below is a plain SELECT (no FOR UPDATE). It exists
   * for fast feedback / good UX only. The authoritative protection against a
   * race between two simultaneous bookings is the DB EXCLUDE constraint, which
   * BookingService relies on at INSERT time.
   */
  async checkAvailability(
    tenantId: string,
    roomId: string,
    checkIn: Date,
    checkOut: Date,
    // When modifying an existing reservation, exclude it from the overlap check
    // so it doesn't conflict with itself.
    excludeReservationId?: string,
  ): Promise<AvailabilityResult> {
    const nights = Math.round(
      (checkOut.getTime() - checkIn.getTime()) / MS_PER_DAY,
    );
    if (nights <= 0) {
      return { available: false, reason: 'check_out must be after check_in' };
    }

    // Room must belong to this tenant (tenant_id is always part of the filter).
    const room = await this.prisma.room.findFirst({
      where: { id: roomId, tenantId },
    });
    if (!room) {
      return { available: false, reason: 'room not found' };
    }

    // (a) Overlap against active reservations. Half-open ranges: an existing
    // stay conflicts iff existing.check_in < checkOut AND existing.check_out > checkIn.
    const conflict = await this.prisma.reservation.findFirst({
      where: {
        tenantId,
        roomId,
        status: { in: ACTIVE_STATUSES },
        checkIn: { lt: checkOut },
        checkOut: { gt: checkIn },
        ...(excludeReservationId ? { id: { not: excludeReservationId } } : {}),
      },
      select: { id: true },
    });
    if (conflict) {
      return {
        available: false,
        nights,
        reason: 'room not available for the selected dates',
      };
    }

    // Seasons (business rules as DATA) overlapping the stay for this room type.
    const seasons = await this.prisma.season.findMany({
      where: {
        tenantId,
        roomType: room.roomType,
        startDate: { lt: checkOut },
        endDate: { gte: checkIn },
      },
    });

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
    });

    // (b) min/max stay — most restrictive across overlapping seasons, with the
    // tenant default as a floor. Nothing hardcoded; all values come from tables.
    let minStay = settings?.defaultMinStay ?? 1;
    let maxStay: number | null = null;
    for (const s of seasons) {
      if (s.minStay > minStay) minStay = s.minStay;
      if (s.maxStay != null) {
        maxStay = maxStay == null ? s.maxStay : Math.min(maxStay, s.maxStay);
      }
    }
    if (nights < minStay) {
      return {
        available: false,
        nights,
        reason: `minimum stay is ${minStay} night(s)`,
      };
    }
    if (maxStay != null && nights > maxStay) {
      return {
        available: false,
        nights,
        reason: `maximum stay is ${maxStay} night(s)`,
      };
    }

    // (c) Price: per-night base_price × season modifier (if a season covers that
    // night), summed, then tax from tenant_settings applied to the subtotal.
    let subtotal = new Prisma.Decimal(0);
    for (let i = 0; i < nights; i++) {
      const night = new Date(checkIn.getTime() + i * MS_PER_DAY);
      const season = seasons.find(
        (s) => s.startDate <= night && night <= s.endDate,
      );
      const modifier = season ? season.priceModifier : new Prisma.Decimal(1);
      subtotal = subtotal.add(room.basePrice.mul(modifier));
    }
    const taxRate = settings?.taxRate ?? new Prisma.Decimal(0);
    const total = subtotal
      .mul(new Prisma.Decimal(1).add(taxRate))
      .toDecimalPlaces(2);

    return { available: true, nights, totalPrice: total.toFixed(2) };
  }
}
