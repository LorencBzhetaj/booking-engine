import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Expires stale holds. A reservation left 'pending' past its hold_expires_at is
 * flipped to 'expired'. Once out of ('pending','confirmed') it automatically
 * leaves the EXCLUDE constraint's WHERE clause, freeing the dates — no constraint
 * change required.
 */
@Injectable()
export class ReservationExpiryService {
  private readonly logger = new Logger(ReservationExpiryService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    const count = await this.expirePendingReservations();
    if (count > 0) {
      this.logger.log(`Expired ${count} stale pending reservation(s)`);
    }
  }

  /** Returns the number of reservations expired. Also callable directly (tests). */
  async expirePendingReservations(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.reservation.updateMany({
      where: {
        status: ReservationStatus.pending,
        holdExpiresAt: { lt: now },
      },
      data: { status: ReservationStatus.expired },
    });
    return result.count;
  }
}
