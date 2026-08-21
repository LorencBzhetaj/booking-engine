import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Render,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingService } from '../bookings/bookings.service';

const ACTIVE: ReservationStatus[] = [
  ReservationStatus.pending,
  ReservationStatus.confirmed,
];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Minimal server-rendered admin. READ-ONLY over reservations (list + calendar);
 * simple CRUD over rooms and seasons. It only surfaces existing data/logic — it
 * introduces NO new business rules (pricing/availability stay in the services).
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly booking: BookingService,
  ) {}

  /** The single active tenant (Phase 3 is single-tenant). */
  private async tenant() {
    const tenant = await this.prisma.tenant.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!tenant) throw new ConflictException('no tenant configured');
    return tenant;
  }

  // ---- 1) Reservations list -------------------------------------------------
  @Get('reservations')
  @Render('reservations')
  async reservations(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('ok') ok?: string,
    @Query('error') error?: string,
  ) {
    const tenant = await this.tenant();

    // Default window: next 30 days (by check-in).
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to
      ? new Date(to)
      : new Date(fromDate.getTime() + 30 * 86_400_000);

    const where: Prisma.ReservationWhereInput = {
      tenantId: tenant.id,
      checkIn: { gte: fromDate, lte: toDate },
    };
    if (status && status !== 'all') {
      where.status = status as ReservationStatus;
    }

    const [reservations, rooms] = await Promise.all([
      this.prisma.reservation.findMany({
        where,
        include: { room: true },
        orderBy: { checkIn: 'asc' },
      }),
      this.prisma.room.findMany({
        where: { tenantId: tenant.id },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      title: 'Reservations',
      currency: tenant.currency,
      statuses: ['all', 'pending', 'confirmed', 'cancelled', 'expired'],
      filter: {
        status: status ?? 'all',
        from: isoDate(fromDate),
        to: isoDate(toDate),
      },
      rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
      ok,
      error,
      reservations: reservations.map((r) => ({
        id: r.id,
        roomId: r.roomId,
        guestName: r.guestName,
        guestEmail: r.guestEmail,
        roomName: r.room.name,
        checkIn: isoDate(r.checkIn),
        checkOut: isoDate(r.checkOut),
        status: r.status,
        paymentStatus: r.paymentStatus,
        totalPrice: r.totalPrice.toFixed(2),
        source: r.source,
        active: ACTIVE.includes(r.status),
      })),
    };
  }

  // Cancel a reservation → frees the dates (leaves the EXCLUDE guard).
  @Post('reservations/:id/cancel')
  async cancelReservation(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.booking.cancelReservation(id);
      res.redirect('/admin/reservations?ok=cancelled');
    } catch (e) {
      res.redirect(
        `/admin/reservations?error=${encodeURIComponent((e as Error).message)}`,
      );
    }
  }

  // Modify a reservation's room and/or dates (atomic, re-checks the constraint).
  @Put('reservations/:id')
  async modifyReservation(
    @Param('id') id: string,
    @Body() body: { roomId?: string; checkIn?: string; checkOut?: string },
    @Res() res: Response,
  ): Promise<void> {
    try {
      await this.booking.modifyReservation(id, {
        roomId: body.roomId || undefined,
        checkIn: body.checkIn ? new Date(body.checkIn) : undefined,
        checkOut: body.checkOut ? new Date(body.checkOut) : undefined,
      });
      res.redirect('/admin/reservations?ok=updated');
    } catch (e) {
      res.redirect(
        `/admin/reservations?error=${encodeURIComponent((e as Error).message)}`,
      );
    }
  }

  // ---- 2) Monthly calendar --------------------------------------------------
  @Get('calendar')
  @Render('calendar')
  async calendar(@Query('month') month?: string, @Query('year') year?: string) {
    const tenant = await this.tenant();
    const now = new Date();
    const y = year ? parseInt(year, 10) : now.getUTCFullYear();
    const m = month ? parseInt(month, 10) - 1 : now.getUTCMonth(); // 0-based

    const monthStart = new Date(Date.UTC(y, m, 1));
    const monthEnd = new Date(Date.UTC(y, m + 1, 0)); // last day of month
    const daysInMonth = monthEnd.getUTCDate();

    const rooms = await this.prisma.room.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });

    // Reservations overlapping the month (any status, so we can colour them).
    const reservations = await this.prisma.reservation.findMany({
      where: {
        tenantId: tenant.id,
        checkIn: { lte: new Date(Date.UTC(y, m + 1, 1)) },
        checkOut: { gt: monthStart },
      },
    });

    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    const rows = rooms.map((room) => {
      const cells = days.map((day) => {
        const cellDate = new Date(Date.UTC(y, m, day));
        // Half-open [checkIn, checkOut): a day is occupied if checkIn<=day<checkOut.
        const res = reservations.find(
          (r) =>
            r.roomId === room.id &&
            r.checkIn.getTime() <= cellDate.getTime() &&
            cellDate.getTime() < r.checkOut.getTime(),
        );
        return { day, status: res ? res.status : 'free' };
      });
      return { roomName: room.name, cells };
    });

    return {
      title: 'Calendar',
      year: y,
      month: m + 1,
      monthLabel: monthStart.toLocaleString('en', {
        month: 'long',
        timeZone: 'UTC',
      }),
      prev: m === 0 ? { year: y - 1, month: 12 } : { year: y, month: m },
      next: m === 11 ? { year: y + 1, month: 1 } : { year: y, month: m + 2 },
      days,
      rows,
    };
  }

  // ---- 3) Rooms CRUD --------------------------------------------------------
  @Get('rooms')
  @Render('rooms')
  async rooms(
    @Query('error') error?: string,
    @Query('ok') ok?: string,
  ) {
    const tenant = await this.tenant();
    const rooms = await this.prisma.room.findMany({
      where: { tenantId: tenant.id },
      orderBy: { name: 'asc' },
    });
    return {
      title: 'Rooms',
      currency: tenant.currency,
      rooms: rooms.map((r) => ({
        id: r.id,
        name: r.name,
        roomType: r.roomType,
        capacity: r.capacity,
        basePrice: r.basePrice.toFixed(2),
      })),
      error,
      ok,
    };
  }

  @Post('rooms')
  async createRoom(
    @Body() body: RoomBody,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = await this.tenant();
    await this.prisma.room.create({
      data: {
        tenantId: tenant.id,
        name: body.name,
        roomType: body.roomType,
        capacity: parseInt(String(body.capacity), 10),
        basePrice: new Prisma.Decimal(body.basePrice),
      },
    });
    res.redirect('/admin/rooms?ok=created');
  }

  @Put('rooms/:id')
  async updateRoom(
    @Param('id') id: string,
    @Body() body: RoomBody,
    @Res() res: Response,
  ): Promise<void> {
    await this.prisma.room.update({
      where: { id },
      data: {
        name: body.name,
        roomType: body.roomType,
        capacity: parseInt(String(body.capacity), 10),
        basePrice: new Prisma.Decimal(body.basePrice),
      },
    });
    res.redirect('/admin/rooms?ok=updated');
  }

  @Delete('rooms/:id')
  async deleteRoom(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    // Block deletion of a room that still has active (pending/confirmed)
    // reservations — no cascade delete.
    const active = await this.prisma.reservation.count({
      where: { roomId: id, status: { in: ACTIVE } },
    });
    if (active > 0) {
      res.redirect('/admin/rooms?error=has_active_reservations');
      return;
    }
    await this.prisma.room.delete({ where: { id } });
    res.redirect('/admin/rooms?ok=deleted');
  }

  // ---- 4) Seasons CRUD ------------------------------------------------------
  @Get('seasons')
  @Render('seasons')
  async seasons(
    @Query('warning') warning?: string,
    @Query('ok') ok?: string,
  ) {
    const tenant = await this.tenant();
    const seasons = await this.prisma.season.findMany({
      where: { tenantId: tenant.id },
      orderBy: [{ roomType: 'asc' }, { startDate: 'asc' }],
    });
    const roomTypes = await this.distinctRoomTypes(tenant.id);
    return {
      title: 'Seasons',
      roomTypes,
      seasons: seasons.map((s) => ({
        id: s.id,
        roomType: s.roomType,
        name: s.name,
        startDate: isoDate(s.startDate),
        endDate: isoDate(s.endDate),
        priceModifier: s.priceModifier.toString(),
        minStay: s.minStay,
        maxStay: s.maxStay,
      })),
      warning,
      ok,
    };
  }

  @Post('seasons')
  async createSeason(
    @Body() body: SeasonBody,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = await this.tenant();
    const overlaps = await this.seasonOverlaps(
      tenant.id,
      body.roomType,
      new Date(body.startDate),
      new Date(body.endDate),
      null,
    );
    await this.prisma.season.create({
      data: {
        tenantId: tenant.id,
        roomType: body.roomType,
        name: body.name || null,
        startDate: new Date(body.startDate),
        endDate: new Date(body.endDate),
        priceModifier: new Prisma.Decimal(body.priceModifier),
        minStay: parseInt(String(body.minStay), 10),
        maxStay: body.maxStay ? parseInt(String(body.maxStay), 10) : null,
      },
    });
    res.redirect(overlaps ? '/admin/seasons?warning=overlap' : '/admin/seasons?ok=created');
  }

  @Put('seasons/:id')
  async updateSeason(
    @Param('id') id: string,
    @Body() body: SeasonBody,
    @Res() res: Response,
  ): Promise<void> {
    const tenant = await this.tenant();
    const overlaps = await this.seasonOverlaps(
      tenant.id,
      body.roomType,
      new Date(body.startDate),
      new Date(body.endDate),
      id,
    );
    await this.prisma.season.update({
      where: { id },
      data: {
        roomType: body.roomType,
        name: body.name || null,
        startDate: new Date(body.startDate),
        endDate: new Date(body.endDate),
        priceModifier: new Prisma.Decimal(body.priceModifier),
        minStay: parseInt(String(body.minStay), 10),
        maxStay: body.maxStay ? parseInt(String(body.maxStay), 10) : null,
      },
    });
    res.redirect(overlaps ? '/admin/seasons?warning=overlap' : '/admin/seasons?ok=updated');
  }

  @Delete('seasons/:id')
  async deleteSeason(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    await this.prisma.season.delete({ where: { id } });
    res.redirect('/admin/seasons?ok=deleted');
  }

  // ---- helpers --------------------------------------------------------------
  private async distinctRoomTypes(tenantId: string): Promise<string[]> {
    const rooms = await this.prisma.room.findMany({
      where: { tenantId },
      select: { roomType: true },
      distinct: ['roomType'],
      orderBy: { roomType: 'asc' },
    });
    return rooms.map((r) => r.roomType);
  }

  /** Warns (does not block) when a season overlaps another for the same type. */
  private async seasonOverlaps(
    tenantId: string,
    roomType: string,
    startDate: Date,
    endDate: Date,
    excludeId: string | null,
  ): Promise<boolean> {
    const clash = await this.prisma.season.findFirst({
      where: {
        tenantId,
        roomType,
        startDate: { lte: endDate },
        endDate: { gte: startDate },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    return clash != null;
  }
}

interface RoomBody {
  name: string;
  roomType: string;
  capacity: string | number;
  basePrice: string;
}

interface SeasonBody {
  roomType: string;
  name?: string;
  startDate: string;
  endDate: string;
  priceModifier: string;
  minStay: string | number;
  maxStay?: string | number;
}
