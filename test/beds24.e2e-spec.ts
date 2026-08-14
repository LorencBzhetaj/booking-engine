import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Beds24Service } from '../src/beds24/beds24.service';
import { Beds24SyncService } from '../src/beds24/beds24-sync.service';
import { EmailService } from '../src/email/email.service';

/**
 * Phase 4 (Beds24 bridge) — every call to the Beds24 HTTP API is mocked; no test
 * ever contacts the real API. Covers both directions, idempotency, and the
 * critical cross-channel double-booking case.
 */
describe('Phase 4: Beds24 sync (mocked API)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sync: Beds24SyncService;
  let createBookingSpy: jest.SpyInstance;
  let adminAlertSpy: jest.SpyInstance;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomId = '00000000-0000-0000-0000-0000000000a2'; // Dhoma Dopio 2
  const BEDS24_ROOM = '999002';

  // Snapshot of any REAL Beds24 config so the test never destroys live creds.
  let orig: {
    beds24ApiKey: string | null;
    beds24PropId: string | null;
    roomBeds24RoomId: string | null;
  };

  const beds24Url = () => request(app.getHttpServer()).post('/webhooks/beds24');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    sync = app.get(Beds24SyncService);

    // Snapshot real config first, so afterAll can restore it (never clobber
    // live credentials / room mapping with test dummies).
    const settingsNow = await prisma.tenantSettings.findUnique({
      where: { tenantId },
    });
    const roomNow = await prisma.room.findUnique({ where: { id: roomId } });
    orig = {
      beds24ApiKey: settingsNow?.beds24ApiKey ?? null,
      beds24PropId: settingsNow?.beds24PropId ?? null,
      roomBeds24RoomId: roomNow?.beds24RoomId ?? null,
    };

    // Configure the Beds24 integration on the seeded tenant/room (test values).
    await prisma.room.update({
      where: { id: roomId },
      data: { beds24RoomId: BEDS24_ROOM },
    });
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: { beds24ApiKey: 'refresh_dummy', beds24PropId: '777' },
    });

    // Mock the Beds24 HTTP client (Direction 2) and the admin alert email.
    createBookingSpy = jest
      .spyOn(app.get(Beds24Service), 'createBooking')
      .mockResolvedValue({ ok: true });
    adminAlertSpy = jest
      .spyOn(app.get(EmailService), 'sendAdminAlert')
      .mockResolvedValue(undefined);

    await clean();
  });

  afterAll(async () => {
    await clean();
    // Restore whatever was there before (real creds/mapping, or null).
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: { beds24ApiKey: orig.beds24ApiKey, beds24PropId: orig.beds24PropId },
    });
    await prisma.room.update({
      where: { id: roomId },
      data: { beds24RoomId: orig.roomBeds24RoomId },
    });
    if (app) await app.close();
  });

  async function clean() {
    await prisma.reservation.deleteMany({
      where: { roomId, checkIn: { gte: new Date('2027-01-01') } },
    });
  }

  const otaPayload = (over: Record<string, unknown>) => ({
    booking: {
      id: 555001,
      roomId: Number(BEDS24_ROOM),
      status: 'confirmed',
      arrival: '2027-03-05',
      departure: '2027-03-08',
      firstName: 'OTA',
      lastName: 'Guest',
      email: 'ota@example.com',
      price: 240,
      ...over,
    },
  });

  // ---- Direction 1 ----------------------------------------------------------
  it('imports a new OTA booking (source=beds24, confirmed/paid)', async () => {
    const res = await beds24Url().send(otaPayload({})).expect(200);
    expect(res.body.status).toBe('created');

    const r = await prisma.reservation.findUnique({
      where: { externalBookingId: '555001' },
    });
    expect(r?.source).toBe('beds24');
    expect(r?.status).toBe('confirmed');
    expect(r?.paymentStatus).toBe('paid');
    expect(r?.roomId).toBe(roomId);
  });

  it('is idempotent: the same OTA booking twice creates only one row', async () => {
    const res = await beds24Url().send(otaPayload({})).expect(200);
    expect(res.body.status).toBe('duplicate');

    const count = await prisma.reservation.count({
      where: { externalBookingId: '555001' },
    });
    expect(count).toBe(1);
  });

  it('flags a cross-channel double-booking loudly and does NOT import it', async () => {
    // Overlaps the 2027-03-05..08 booking already imported above, new OTA id.
    const res = await beds24Url()
      .send(otaPayload({ id: 555002, arrival: '2027-03-06', departure: '2027-03-09' }))
      .expect(200);
    expect(res.body.status).toBe('conflict');

    // Not imported, and an admin alert was raised.
    const clash = await prisma.reservation.findUnique({
      where: { externalBookingId: '555002' },
    });
    expect(clash).toBeNull();
    expect(adminAlertSpy).toHaveBeenCalledTimes(1);
  });

  it('reports unmapped when the Beds24 room has no local mapping', async () => {
    const res = await beds24Url()
      .send(otaPayload({ id: 555003, roomId: 888888 }))
      .expect(200);
    expect(res.body.status).toBe('unmapped');
  });

  it('rejects an inbound webhook with a wrong shared secret when configured', async () => {
    process.env.BEDS24_WEBHOOK_SECRET = 'sekret';
    await beds24Url().query({ token: 'wrong' }).send(otaPayload({ id: 555009 })).expect(400);
    await beds24Url().query({ token: 'sekret' }).send(otaPayload({ id: 555009, arrival: '2027-06-01', departure: '2027-06-03' })).expect(200);
    delete process.env.BEDS24_WEBHOOK_SECRET;
  });

  // ---- Direction 2 ----------------------------------------------------------
  it('pushes a confirmed DIRECT booking to Beds24 (blocks OTA dates)', async () => {
    const r = await prisma.reservation.create({
      data: {
        tenantId,
        roomId,
        checkIn: new Date('2027-04-01'),
        checkOut: new Date('2027-04-03'),
        guestName: 'Direct Guest',
        guestEmail: 'direct@example.com',
        status: 'confirmed',
        paymentStatus: 'paid',
        source: 'direct',
        totalPrice: new Prisma.Decimal('120.00'),
      },
    });

    const result = await sync.pushDirectBooking(r.id);
    expect(result.pushed).toBe(true);
    expect(createBookingSpy).toHaveBeenCalledWith(
      'refresh_dummy',
      expect.objectContaining({
        propertyId: 777,
        roomId: 999002,
        arrival: '2027-04-01',
        departure: '2027-04-03',
      }),
    );
  });

  it('push failure is best-effort: logs, does not throw, keeps the local booking', async () => {
    createBookingSpy.mockRejectedValueOnce(new Error('network down'));
    const r = await prisma.reservation.create({
      data: {
        tenantId,
        roomId,
        checkIn: new Date('2027-05-01'),
        checkOut: new Date('2027-05-03'),
        guestName: 'Direct Guest 2',
        guestEmail: 'direct2@example.com',
        status: 'confirmed',
        paymentStatus: 'paid',
        source: 'direct',
        totalPrice: new Prisma.Decimal('120.00'),
      },
    });

    const result = await sync.pushDirectBooking(r.id);
    expect(result.pushed).toBe(false);
    expect(result.skipped).toBe('push_failed');

    // Local reservation is untouched — it is the source of truth.
    const still = await prisma.reservation.findUnique({ where: { id: r.id } });
    expect(still).toBeTruthy();
  });
});
