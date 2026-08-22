import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'crypto';
import { PaymentStatus, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AvailabilityService } from '../availability/availability.service';
import { PayPalService } from '../paypal/paypal.service';
import { EmailService } from '../email/email.service';
import { Beds24SyncService } from '../beds24/beds24-sync.service';

export interface CreateBookingInput {
  tenantId: string;
  roomId: string;
  checkIn: Date;
  checkOut: Date;
  guestName: string;
  guestEmail: string;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Human-readable booking code, e.g. RES-2026-7Q3F2A. Ambiguous chars omitted.
function genConfirmationNumber(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[randomInt(alphabet.length)];
  return `RES-${new Date().getFullYear()}-${code}`;
}

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly paypal: PayPalService,
    private readonly email: EmailService,
    private readonly beds24Sync: Beds24SyncService,
  ) {}

  async createBooking(input: CreateBookingInput) {
    const { tenantId, roomId, checkIn, checkOut, guestName, guestEmail } = input;

    // Fast pre-check for good UX: clear message before we even try to insert.
    // This is NOT the race guard — see the try/catch below for that.
    const check = await this.availability.checkAvailability(
      tenantId,
      roomId,
      checkIn,
      checkOut,
    );
    if (!check.available) {
      const reason = check.reason ?? 'not available';
      if (reason === 'room not found') {
        throw new NotFoundException(reason);
      }
      if (reason.includes('not available for the selected dates')) {
        throw new ConflictException('room no longer available');
      }
      // min/max stay, invalid dates, etc.
      throw new BadRequestException(reason);
    }

    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
    });
    // 'on_arrival' (default): confirm immediately, guest pays at the property.
    // 'prepaid': hold as pending until an online payment confirms it.
    const onArrival = (settings?.paymentMode ?? 'on_arrival') === 'on_arrival';
    const holdMinutes = settings?.holdDurationMinutes ?? 30;

    let reservation;
    try {
      // The INSERT is the real concurrency guard. If a competing request slipped
      // in between the pre-check and here, the DB EXCLUDE constraint rejects this
      // one with SQLSTATE 23P01, which we translate to a 409.
      reservation = await this.prisma.reservation.create({
        data: {
          tenantId,
          roomId,
          checkIn,
          checkOut,
          guestName,
          guestEmail,
          confirmationNumber: genConfirmationNumber(),
          status: onArrival
            ? ReservationStatus.confirmed
            : ReservationStatus.pending,
          paymentStatus: PaymentStatus.unpaid,
          totalPrice: new Prisma.Decimal(check.totalPrice!),
          holdExpiresAt: onArrival
            ? null
            : new Date(Date.now() + holdMinutes * 60_000),
        },
      });
    } catch (e) {
      if (this.isExclusionViolation(e)) {
        throw new ConflictException('room no longer available');
      }
      throw e;
    }

    // Pay-on-arrival bookings are confirmed on creation: send the confirmation
    // email and push the block to the OTAs, same side-effects as a paid booking.
    if (onArrival) {
      await this.notifyConfirmed(reservation.id, { payOnArrival: true });
    }
    return reservation;
  }

  /**
   * Creates a PayPal order for a still-pending reservation. Returns both the
   * PayPal order id (used by the JS SDK Smart Buttons) and the approve URL
   * (redirect fallback). reservationId travels as the order's custom_id so the
   * webhook can confirm it.
   */
  async createCheckoutSession(
    reservationId: string,
  ): Promise<{ orderId: string; url: string }> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { room: true, tenant: true },
    });
    if (!reservation) {
      throw new NotFoundException('reservation not found');
    }
    if (reservation.status !== ReservationStatus.pending) {
      throw new ConflictException(
        `reservation is not pending (status: ${reservation.status})`,
      );
    }

    const base = process.env.APP_PUBLIC_URL ?? 'http://localhost:3001';

    const order = await this.paypal.createOrder({
      amount: new Prisma.Decimal(reservation.totalPrice).toFixed(2),
      currency: reservation.tenant.currency,
      reservationId: reservation.id,
      description: `${reservation.tenant.name} — ${reservation.room.name} (${isoDate(reservation.checkIn)} → ${isoDate(reservation.checkOut)})`,
      returnUrl: `${base}/booking/success?reservationId=${reservation.id}`,
      cancelUrl: `${base}/booking/cancel?reservationId=${reservation.id}`,
    });

    return { orderId: order.id, url: order.approveUrl };
  }

  /**
   * Captures a PayPal order approved inline via the JS SDK (onApprove), then
   * confirms the reservation. Confirmation reuses the same idempotent path as
   * the webhook, so the PAYMENT.CAPTURE.COMPLETED webhook remains a harmless
   * redundancy.
   */
  async captureReservation(
    reservationId: string,
    orderId: string,
  ): Promise<{ status: string; confirmed: boolean }> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation) {
      throw new NotFoundException('reservation not found');
    }

    const capture = (await this.paypal.captureOrder(orderId)) as {
      status?: string;
    };
    const status = capture?.status ?? 'UNKNOWN';

    let confirmed = false;
    if (status === 'COMPLETED') {
      const result = await this.confirmFromWebhook(reservationId);
      confirmed = result.changed || reservation.status === ReservationStatus.confirmed;
    }
    return { status, confirmed };
  }

  /**
   * Idempotently confirms a reservation from a payment webhook. Safe to call
   * multiple times for the same event (PayPal delivers duplicates/retries):
   *   - transitions pending -> confirmed/paid EXACTLY once (atomic updateMany
   *     guarded by status='pending'), and only then sends the email;
   *   - any later call finds status != pending, changes nothing, sends nothing.
   * Returns whether this call was the one that performed the transition.
   */
  async confirmFromWebhook(
    reservationId: string,
  ): Promise<{ changed: boolean }> {
    const result = await this.prisma.reservation.updateMany({
      where: { id: reservationId, status: ReservationStatus.pending },
      data: {
        status: ReservationStatus.confirmed,
        paymentStatus: PaymentStatus.paid,
      },
    });

    if (result.count !== 1) {
      // Not found, or already confirmed/expired/cancelled — do nothing.
      return { changed: false };
    }

    await this.notifyConfirmed(reservationId, { payOnArrival: false });
    return { changed: true };
  }

  /**
   * Side-effects of a confirmed reservation, shared by the pay-on-arrival path
   * and the payment webhook: send the confirmation email and (for direct
   * bookings) push the block to the OTAs via Beds24. Best effort — never throws.
   */
  private async notifyConfirmed(
    reservationId: string,
    opts: { payOnArrival: boolean },
  ): Promise<void> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      include: { room: true, tenant: { include: { settings: true } } },
    });
    if (!reservation) return;

    const from = reservation.tenant.settings?.emailFrom;
    if (!from) {
      this.logger.warn(
        `tenant ${reservation.tenantId} has no email_from configured; skipping confirmation email`,
      );
    } else {
      await this.email.sendBookingConfirmation({
        to: reservation.guestEmail,
        from,
        tenantName: reservation.tenant.name,
        guestName: reservation.guestName,
        roomName: reservation.room.name,
        checkIn: isoDate(reservation.checkIn),
        checkOut: isoDate(reservation.checkOut),
        totalPrice: reservation.totalPrice.toFixed(2),
        currency: reservation.tenant.currency,
        payOnArrival: opts.payOnArrival,
      });
    }

    // Direction 2: block the same dates on the OTAs via Beds24. Best effort —
    // pushDirectBooking never throws; a failure is logged for manual retry.
    if (reservation.source === 'direct') {
      await this.beds24Sync.pushDirectBooking(reservation.id);
    }
  }

  /**
   * Cancels a reservation (admin action). Once out of ('pending','confirmed')
   * the dates leave the EXCLUDE guard and become bookable again automatically.
   */
  async cancelReservation(reservationId: string) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation) throw new NotFoundException('reservation not found');
    if (
      reservation.status !== ReservationStatus.pending &&
      reservation.status !== ReservationStatus.confirmed
    ) {
      throw new ConflictException(
        `cannot cancel a ${reservation.status} reservation`,
      );
    }
    return this.prisma.reservation.update({
      where: { id: reservationId },
      data: { status: ReservationStatus.cancelled },
    });
  }

  /**
   * Modifies an existing reservation's room and/or dates (admin action).
   * Safe against double-booking: the single UPDATE re-checks the EXCLUDE
   * constraint (a conflicting move raises 23P01 -> 409); the pre-check ignores
   * the reservation itself. Recomputes the price and re-notifies Beds24.
   */
  async modifyReservation(
    reservationId: string,
    changes: { roomId?: string; checkIn?: Date; checkOut?: Date },
  ) {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    if (!reservation) throw new NotFoundException('reservation not found');
    if (
      reservation.status !== ReservationStatus.pending &&
      reservation.status !== ReservationStatus.confirmed
    ) {
      throw new ConflictException(
        `cannot modify a ${reservation.status} reservation`,
      );
    }

    const roomId = changes.roomId ?? reservation.roomId;
    const checkIn = changes.checkIn ?? reservation.checkIn;
    const checkOut = changes.checkOut ?? reservation.checkOut;

    // Pre-check price + stay rules, excluding this reservation from the overlap.
    const check = await this.availability.checkAvailability(
      reservation.tenantId,
      roomId,
      checkIn,
      checkOut,
      reservationId,
    );
    if (!check.available) {
      const reason = check.reason ?? 'not available';
      if (reason === 'room not found') throw new NotFoundException(reason);
      if (reason.includes('not available for the selected dates')) {
        throw new ConflictException('room not available for the new dates');
      }
      throw new BadRequestException(reason);
    }

    let updated;
    try {
      updated = await this.prisma.reservation.update({
        where: { id: reservationId },
        data: {
          roomId,
          checkIn,
          checkOut,
          totalPrice: new Prisma.Decimal(check.totalPrice!),
        },
      });
    } catch (e) {
      if (this.isExclusionViolation(e)) {
        throw new ConflictException('room not available for the new dates');
      }
      throw e;
    }

    // Keep Beds24 in sync after a manual change (best effort, never throws) —
    // includeOta so OTA-sourced bookings are re-notified too.
    await this.beds24Sync.pushDirectBooking(reservationId, { includeOta: true });

    return updated;
  }

  /** Detects a PostgreSQL exclusion_violation (SQLSTATE 23P01). */
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
