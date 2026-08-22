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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingService } from '../bookings/bookings.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];

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
    private readonly cloudinary: CloudinaryService,
  ) {}

  /** The single active tenant (Phase 3 is single-tenant). */
  private async tenant() {
    const tenant = await this.prisma.tenant.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (!tenant) throw new ConflictException('no tenant configured');
    return tenant;
  }

  // ---- 0) Dashboard ---------------------------------------------------------
  @Get()
  root(@Res() res: Response): void {
    res.redirect('/admin/dashboard');
  }

  // Small at-a-glance dashboard. Pure aggregation of existing queries — no new
  // business rules. Arrivals/departures today, pending awaiting action, and a
  // simple 7-day occupancy (occupied rooms per day / total rooms).
  @Get('dashboard')
  @Render('dashboard')
  async dashboard() {
    const tenant = await this.tenant();
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const weekEnd = new Date(today.getTime() + 7 * 86_400_000);

    const [rooms, arrivals, departures, pendingCount, windowRes] =
      await Promise.all([
        this.prisma.room.findMany({ where: { tenantId: tenant.id } }),
        this.prisma.reservation.findMany({
          where: { tenantId: tenant.id, status: { in: ACTIVE }, checkIn: today },
          include: { room: true },
          orderBy: { checkIn: 'asc' },
        }),
        this.prisma.reservation.findMany({
          where: { tenantId: tenant.id, status: { in: ACTIVE }, checkOut: today },
          include: { room: true },
          orderBy: { checkOut: 'asc' },
        }),
        this.prisma.reservation.count({
          where: { tenantId: tenant.id, status: ReservationStatus.pending },
        }),
        this.prisma.reservation.findMany({
          where: {
            tenantId: tenant.id,
            status: { in: ACTIVE },
            checkIn: { lt: weekEnd },
            checkOut: { gt: today },
          },
          select: { checkIn: true, checkOut: true },
        }),
      ]);

    const roomsTotal = rooms.length;
    const days = Array.from({ length: 7 }, (_, i) => {
      const day = new Date(today.getTime() + i * 86_400_000);
      const occupied = windowRes.filter(
        (r) =>
          r.checkIn.getTime() <= day.getTime() &&
          day.getTime() < r.checkOut.getTime(),
      ).length;
      return {
        date: isoDate(day),
        weekday: day.toLocaleDateString('en', {
          weekday: 'short',
          timeZone: 'UTC',
        }),
        occupied,
        total: roomsTotal,
        pct: roomsTotal ? Math.round((occupied / roomsTotal) * 100) : 0,
      };
    });
    const occupiedRoomNights = days.reduce((s, d) => s + d.occupied, 0);
    const totalRoomNights = roomsTotal * 7;

    const mapRes = (r: {
      guestName: string;
      room: { name: string };
      status: string;
      checkIn: Date;
      checkOut: Date;
    }) => ({
      guestName: r.guestName,
      roomName: r.room.name,
      status: r.status,
      checkIn: isoDate(r.checkIn),
      checkOut: isoDate(r.checkOut),
    });

    return {
      title: 'Dashboard',
      today: isoDate(today),
      roomsTotal,
      arrivals: arrivals.map(mapRes),
      departures: departures.map(mapRes),
      pendingCount,
      occupiedRoomNights,
      totalRoomNights,
      occupancyPct: totalRoomNights
        ? Math.round((occupiedRoomNights / totalRoomNights) * 100)
        : 0,
      days,
    };
  }

  // ---- 1) Reservations list -------------------------------------------------
  @Get('reservations')
  @Render('reservations')
  async reservations(
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    @Query('ok') ok?: string,
    @Query('error') error?: string,
  ) {
    const tenant = await this.tenant();
    const search = (q ?? '').trim();

    // Default window: next 30 days (by check-in).
    const fromDate = from ? new Date(from) : new Date();
    const toDate = to
      ? new Date(to)
      : new Date(fromDate.getTime() + 30 * 86_400_000);

    const where: Prisma.ReservationWhereInput = { tenantId: tenant.id };
    if (search) {
      // Code/guest search: match across all dates (ignore the date window).
      where.OR = [
        { confirmationNumber: { contains: search, mode: 'insensitive' } },
        { guestName: { contains: search, mode: 'insensitive' } },
        { guestEmail: { contains: search, mode: 'insensitive' } },
      ];
    } else {
      where.checkIn = { gte: fromDate, lte: toDate };
    }
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
        q: search,
      },
      rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
      ok,
      error,
      reservations: reservations.map((r) => ({
        id: r.id,
        roomId: r.roomId,
        guestName: r.guestName,
        guestEmail: r.guestEmail,
        confirmationNumber: r.confirmationNumber,
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
        imageUrl: r.imageUrl,
        amenities: r.amenities ?? '',
      })),
      cloudinaryReady: this.cloudinary.isConfigured(),
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
        amenities: body.amenities || null,
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
        amenities: body.amenities || null,
      },
    });
    res.redirect('/admin/rooms?ok=updated');
  }

  // Upload a room photo to Cloudinary and store the returned URL.
  @Post('rooms/:id/upload-image')
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: 6 * 1024 * 1024 } }),
  )
  async uploadRoomImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const fail = (msg: string) =>
      res.redirect(`/admin/rooms?error=${encodeURIComponent(msg)}`);
    try {
      if (!file) return fail('No file selected.');
      if (!ALLOWED_IMAGE.includes(file.mimetype)) {
        return fail('Only JPG, PNG or WEBP images are allowed.');
      }
      if (file.size > MAX_IMAGE_BYTES) {
        return fail('Image is too large (max 5MB).');
      }
      const url = await this.cloudinary.uploadImage(file.buffer, `room-${id}`);
      await this.prisma.room.update({ where: { id }, data: { imageUrl: url } });
      res.redirect('/admin/rooms?ok=image_uploaded');
    } catch (e) {
      fail((e as Error).message);
    }
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
  amenities?: string;
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
