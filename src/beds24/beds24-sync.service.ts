import { Injectable, Logger } from '@nestjs/common';
import { Prisma, ReservationSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { Beds24Service } from './beds24.service';

/** Loose shape of a Beds24 v2 booking as it appears in webhook payloads. */
interface Beds24Booking {
  id?: number | string;
  roomId?: number | string;
  status?: string;
  arrival?: string;
  departure?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  price?: number | string;
}

export type IngestResult =
  | 'created'
  | 'duplicate'
  | 'conflict'
  | 'unmapped'
  | 'ignored';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Bridges Beds24 <-> local DB. It is a SYNC LAYER on top of the existing
 * services/constraint — it adds no new booking business rules.
 */
@Injectable()
export class Beds24SyncService {
  private readonly logger = new Logger(Beds24SyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly beds24: Beds24Service,
    private readonly email: EmailService,
  ) {}

  // ---- Direction 1: Beds24 (OTA) -> local DB --------------------------------
  async ingestWebhookBooking(payload: unknown): Promise<IngestResult> {
    const b = this.parseBooking(payload);
    if (!b || b.id == null || b.roomId == null || !b.arrival || !b.departure) {
      this.logger.warn('Beds24 webhook: missing/unparseable booking fields');
      return 'ignored';
    }

    const externalBookingId = String(b.id);

    // Idempotency: same OTA booking delivered twice must not create two rows.
    const existing = await this.prisma.reservation.findUnique({
      where: { externalBookingId },
    });
    if (existing) {
      this.logger.log(`Beds24 booking ${externalBookingId} already imported`);
      return 'duplicate';
    }

    const room = await this.prisma.room.findUnique({
      where: { beds24RoomId: String(b.roomId) },
    });
    if (!room) {
      this.logger.error(
        `Beds24 webhook: no local room mapped to beds24RoomId=${b.roomId} (booking ${externalBookingId}) — cannot import`,
      );
      return 'unmapped';
    }

    try {
      // Goes through the SAME EXCLUDE constraint as direct bookings.
      await this.prisma.reservation.create({
        data: {
          tenantId: room.tenantId,
          roomId: room.id,
          checkIn: new Date(b.arrival),
          checkOut: new Date(b.departure),
          guestName:
            `${b.firstName ?? ''} ${b.lastName ?? ''}`.trim() || 'OTA Guest',
          guestEmail: b.email ?? 'no-email@ota.local',
          status: 'confirmed', // OTA bookings arrive already confirmed/paid
          paymentStatus: 'paid',
          source: ReservationSource.beds24,
          externalBookingId,
          totalPrice: new Prisma.Decimal(b.price ?? 0),
        },
      });
      this.logger.log(
        `Imported Beds24 booking ${externalBookingId} into room "${room.name}"`,
      );
      return 'created';
    } catch (e) {
      if (this.isExclusionViolation(e)) {
        // THE critical case: a real cross-channel double-booking (sync gap).
        // Never swallow this — make it loud and alert a human.
        this.logger.error(
          `CROSS-CHANNEL DOUBLE-BOOKING: Beds24 booking ${externalBookingId} ` +
            `for room "${room.name}" (${b.arrival} → ${b.departure}) overlaps an ` +
            `existing reservation. NOT imported. Manual resolution required.`,
        );
        await this.alertAdmin(room.tenantId, room.name, b, externalBookingId);
        return 'conflict';
      }
      throw e;
    }
  }

  private async alertAdmin(
    tenantId: string,
    roomName: string,
    b: Beds24Booking,
    externalBookingId: string,
  ): Promise<void> {
    const [tenant, settings] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId } }),
      this.prisma.tenantSettings.findUnique({ where: { tenantId } }),
    ]);
    const address = settings?.emailFrom;
    if (!address) {
      this.logger.error(
        `Cannot email cross-channel alert for booking ${externalBookingId}: tenant has no email_from`,
      );
      return;
    }
    await this.email.sendAdminAlert({
      to: address,
      from: address,
      subject: `⚠️ Cross-channel double-booking — ${tenant?.name ?? 'hotel'}`,
      body: [
        `A Beds24 (OTA) booking could NOT be imported because it overlaps an existing reservation.`,
        ``,
        `Beds24 booking id: ${externalBookingId}`,
        `Room:              ${roomName}`,
        `Arrival:           ${b.arrival}`,
        `Departure:         ${b.departure}`,
        `Guest:             ${b.firstName ?? ''} ${b.lastName ?? ''}`.trim(),
        ``,
        `Resolve manually in Beds24 / your calendar as soon as possible.`,
      ].join('\n'),
    });
  }

  // ---- Direction 2: local direct booking -> Beds24 (block OTAs) -------------
  // Best effort: failures are logged for retry, never block the local booking.
  async pushDirectBooking(
    reservationId: string,
    // On a manual admin modify we also re-notify OTA-sourced bookings so a
    // changed reservation doesn't drift out of sync with Beds24.
    opts: { includeOta?: boolean } = {},
  ): Promise<{ pushed: boolean; skipped?: string }> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { room: true, tenant: { include: { settings: true } } },
    });
    if (!reservation) return { pushed: false, skipped: 'not_found' };
    if (
      reservation.source !== ReservationSource.direct &&
      !opts.includeOta
    ) {
      return { pushed: false, skipped: 'not_direct' };
    }

    const s = reservation.tenant.settings;
    if (!s?.beds24ApiKey || !s.beds24PropId || !reservation.room.beds24RoomId) {
      this.logger.log(
        `Beds24 push skipped for ${reservationId}: integration not configured`,
      );
      return { pushed: false, skipped: 'not_configured' };
    }

    try {
      await this.beds24.createBooking(s.beds24ApiKey, {
        propertyId: Number(s.beds24PropId),
        roomId: Number(reservation.room.beds24RoomId),
        status: 'confirmed',
        arrival: isoDate(reservation.checkIn),
        departure: isoDate(reservation.checkOut),
        firstName: reservation.guestName,
        lastName: '',
        email: reservation.guestEmail,
        numAdult: 1,
      });
      this.logger.log(
        `Pushed reservation ${reservationId} to Beds24 (OTA dates blocked)`,
      );
      return { pushed: true };
    } catch (e) {
      // Local reservation + DB constraint are the source of truth. Do NOT throw.
      this.logger.error(
        `Beds24 push FAILED for reservation ${reservationId} (needs retry/manual sync): ${String(e)}`,
      );
      return { pushed: false, skipped: 'push_failed' };
    }
  }

  // ---- helpers --------------------------------------------------------------
  private parseBooking(payload: unknown): Beds24Booking | null {
    if (!payload || typeof payload !== 'object') return null;
    const p = payload as Record<string, unknown>;
    const candidate =
      (p.booking as Beds24Booking) ??
      (Array.isArray(p.bookings) ? (p.bookings[0] as Beds24Booking) : undefined) ??
      (p as Beds24Booking);
    if (!candidate || typeof candidate !== 'object') return null;
    return candidate;
  }

  private isExclusionViolation(e: unknown): boolean {
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      const meta = (e.meta ?? {}) as Record<string, unknown>;
      if (String(meta.code) === '23P01') return true;
    }
    const msg = String((e as Error)?.message ?? '');
    return (
      msg.includes('23P01') ||
      msg.includes('reservations_no_double_booking') ||
      msg.toLowerCase().includes('exclusion')
    );
  }
}
