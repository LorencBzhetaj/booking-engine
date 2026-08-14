import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup-app';
import { PrismaService } from '../src/prisma/prisma.service';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 's3cret-e2e';

describe('Phase 3: admin UI (auth + CRUD + delete guard)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  const a1 = '00000000-0000-0000-0000-0000000000a1';
  const createdRoomIds: string[] = [];

  beforeAll(async () => {
    process.env.ADMIN_USER = ADMIN_USER;
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASS, 10);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({
      rawBody: true,
    });
    configureApp(app as NestExpressApplication);
    await app.init();

    prisma = app.get(PrismaService);
    const tenant = await prisma.tenant.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    tenantId = tenant!.id;
  });

  afterAll(async () => {
    // Clean up anything this suite created.
    await prisma.reservation.deleteMany({
      where: { guestEmail: 'admin-e2e@example.com' },
    });
    for (const id of createdRoomIds) {
      await prisma.reservation.deleteMany({ where: { roomId: id } });
      await prisma.room.deleteMany({ where: { id } });
    }
    await prisma.room.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
    if (app) await app.close();
  });

  const auth = (req: request.Test) => req.auth(ADMIN_USER, ADMIN_PASS);

  // ---- Auth -----------------------------------------------------------------
  it('rejects /admin without credentials (401)', async () => {
    await request(app.getHttpServer()).get('/admin/reservations').expect(401);
  });

  it('rejects /admin with a wrong password (401)', async () => {
    await request(app.getHttpServer())
      .get('/admin/reservations')
      .auth(ADMIN_USER, 'wrong-password')
      .expect(401);
  });

  it('allows /admin with correct credentials (200)', async () => {
    const res = await auth(
      request(app.getHttpServer()).get('/admin/reservations'),
    ).expect(200);
    expect(res.text).toContain('Reservations');
  });

  it('calendar and rooms and seasons pages render (200)', async () => {
    await auth(request(app.getHttpServer()).get('/admin/calendar')).expect(200);
    await auth(request(app.getHttpServer()).get('/admin/rooms')).expect(200);
    await auth(request(app.getHttpServer()).get('/admin/seasons')).expect(200);
  });

  // ---- Reservations list + status filter ------------------------------------
  it('filters reservations by status', async () => {
    await prisma.reservation.create({
      data: {
        tenantId,
        roomId: a1,
        checkIn: new Date('2027-01-10'),
        checkOut: new Date('2027-01-12'),
        guestName: 'Admin Filter Guest',
        guestEmail: 'admin-e2e@example.com',
        status: 'confirmed',
        paymentStatus: 'paid',
        totalPrice: new Prisma.Decimal('120.00'),
      },
    });

    const confirmed = await auth(
      request(app.getHttpServer()).get(
        '/admin/reservations?status=confirmed&from=2027-01-01&to=2027-01-31',
      ),
    ).expect(200);
    expect(confirmed.text).toContain('Admin Filter Guest');

    const pending = await auth(
      request(app.getHttpServer()).get(
        '/admin/reservations?status=pending&from=2027-01-01&to=2027-01-31',
      ),
    ).expect(200);
    expect(pending.text).not.toContain('Admin Filter Guest');
  });

  // ---- Rooms CRUD -----------------------------------------------------------
  it('creates and updates a room', async () => {
    // Create
    await auth(
      request(app.getHttpServer())
        .post('/admin/rooms')
        .type('form')
        .send({
          name: 'E2E Room',
          roomType: 'double',
          capacity: '2',
          basePrice: '75.00',
        }),
    ).expect(302);

    const created = await prisma.room.findFirst({
      where: { name: 'E2E Room' },
    });
    expect(created).toBeTruthy();
    createdRoomIds.push(created!.id);

    // Update (PUT)
    await auth(
      request(app.getHttpServer())
        .put(`/admin/rooms/${created!.id}`)
        .type('form')
        .send({
          name: 'E2E Room Renamed',
          roomType: 'double',
          capacity: '3',
          basePrice: '80.00',
        }),
    ).expect(302);

    const updated = await prisma.room.findUnique({
      where: { id: created!.id },
    });
    expect(updated?.name).toBe('E2E Room Renamed');
    expect(updated?.capacity).toBe(3);
    expect(updated?.basePrice.toFixed(2)).toBe('80.00');
  });

  it('blocks deleting a room with active reservations, allows it once free', async () => {
    const room = await prisma.room.create({
      data: {
        tenantId,
        name: 'E2E Deletable',
        roomType: 'double',
        capacity: 2,
        basePrice: new Prisma.Decimal('60.00'),
      },
    });
    createdRoomIds.push(room.id);

    const reservation = await prisma.reservation.create({
      data: {
        tenantId,
        roomId: room.id,
        checkIn: new Date('2027-02-10'),
        checkOut: new Date('2027-02-12'),
        guestName: 'Blocker',
        guestEmail: 'admin-e2e@example.com',
        status: 'confirmed',
        paymentStatus: 'paid',
        totalPrice: new Prisma.Decimal('120.00'),
      },
    });

    // Delete attempt -> blocked (redirect carries the error, room still exists).
    const blocked = await auth(
      request(app.getHttpServer()).delete(`/admin/rooms/${room.id}`),
    ).expect(302);
    expect(blocked.headers.location).toContain('has_active_reservations');
    expect(await prisma.room.findUnique({ where: { id: room.id } })).toBeTruthy();

    // Free the room, then delete succeeds.
    await prisma.reservation.delete({ where: { id: reservation.id } });
    const okDelete = await auth(
      request(app.getHttpServer()).delete(`/admin/rooms/${room.id}`),
    ).expect(302);
    expect(okDelete.headers.location).toContain('ok=deleted');
    expect(await prisma.room.findUnique({ where: { id: room.id } })).toBeNull();
  });

  // ---- Seasons overlap warning ---------------------------------------------
  it('warns (does not block) when a new season overlaps an existing one', async () => {
    // Existing season for 'double' from seed: 2026-07-01..2026-08-31.
    const res = await auth(
      request(app.getHttpServer())
        .post('/admin/seasons')
        .type('form')
        .send({
          roomType: 'double',
          name: 'E2E Overlap',
          startDate: '2026-08-15',
          endDate: '2026-09-15',
          priceModifier: '1.200',
          minStay: '1',
        }),
    ).expect(302);
    expect(res.headers.location).toContain('warning=overlap');

    // Cleanup the season we just added.
    await prisma.season.deleteMany({ where: { name: 'E2E Overlap' } });
  });
});
