import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Beds24Service } from '../src/beds24/beds24.service';

/**
 * REAL concurrency test — goes through the full HTTP layer (controller ->
 * ValidationPipe -> BookingService -> Prisma -> Postgres EXCLUDE constraint).
 * N identical POST /bookings fire in parallel for the same room + dates;
 * exactly one must win (201), the rest must be rejected (409).
 */
describe('Concurrency: POST /bookings (double-booking guard)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  // Seeded tenant + room (see prisma/seed.ts). Dates in September fall OUTSIDE
  // the seeded summer season, so no min-stay rule interferes with the test.
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomId = '00000000-0000-0000-0000-0000000000a1';
  const checkIn = '2026-09-10';
  const checkOut = '2026-09-14';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    // On-arrival bookings confirm immediately and push to Beds24 — stub the
    // network call so this test never hits the real Beds24 API.
    jest
      .spyOn(app.get(Beds24Service), 'createBooking')
      .mockResolvedValue({ ok: true });
    await prisma.reservation.deleteMany({ where: { roomId } });
  });

  afterAll(async () => {
    if (prisma) await prisma.reservation.deleteMany({ where: { roomId } });
    if (app) await app.close();
  });

  it('exactly 1 of 10 parallel identical bookings succeeds; the rest are 409', async () => {
    const N = 10;
    const server = app.getHttpServer();
    const payload = {
      tenantId,
      roomId,
      checkIn,
      checkOut,
      guestName: 'Race Tester',
      guestEmail: 'race@example.com',
    };

    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(server).post('/bookings').send(payload),
      ),
    );

    const counts = responses.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    // eslint-disable-next-line no-console
    console.log('HTTP status counts across parallel requests:', counts);

    const created = responses.filter((r) => r.status === 201);
    const conflict = responses.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflict).toHaveLength(N - 1);
    conflict.forEach((r) =>
      expect(r.body.message).toBe('room no longer available'),
    );

    // Ground truth: the DB holds exactly one active reservation for these dates.
    const active = await prisma.reservation.count({
      where: {
        roomId,
        status: { in: ['pending', 'confirmed'] },
        checkIn: { lt: new Date(checkOut) },
        checkOut: { gt: new Date(checkIn) },
      },
    });
    expect(active).toBe(1);
  }, 60_000);
});
