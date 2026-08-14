import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Beds24Service } from '../src/beds24/beds24.service';
import { EmailService } from '../src/email/email.service';

/**
 * Pay-on-arrival: with tenant_settings.payment_mode='on_arrival' (default),
 * POST /bookings confirms the reservation immediately (guest pays at the
 * property) — no pending hold, no online payment — and sends the confirmation
 * email flagged pay-on-arrival.
 */
describe('Pay-on-arrival booking (payment_mode)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let emailSpy: jest.SpyInstance;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomId = '00000000-0000-0000-0000-0000000000b1'; // Suita Familjare (family)
  const checkIn = '2027-07-10';
  const checkOut = '2027-07-12';
  let origPaymentMode: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    jest.spyOn(app.get(Beds24Service), 'createBooking').mockResolvedValue({ ok: true });
    emailSpy = jest
      .spyOn(app.get(EmailService), 'sendBookingConfirmation')
      .mockResolvedValue(undefined);

    const s = await prisma.tenantSettings.findUnique({ where: { tenantId } });
    origPaymentMode = s?.paymentMode ?? 'on_arrival';
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: { paymentMode: 'on_arrival' },
    });
    await prisma.reservation.deleteMany({ where: { roomId } });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.reservation.deleteMany({ where: { roomId } });
      await prisma.tenantSettings.update({
        where: { tenantId },
        data: { paymentMode: origPaymentMode },
      });
    }
    if (app) await app.close();
  });

  it('confirms immediately as unpaid and emails pay-on-arrival', async () => {
    const res = await request(app.getHttpServer())
      .post('/bookings')
      .send({
        tenantId,
        roomId,
        checkIn,
        checkOut,
        guestName: 'Arrival Guest',
        guestEmail: 'arrival@example.com',
      })
      .expect(201);

    expect(res.body.reservation.status).toBe('confirmed');
    expect(res.body.reservation.paymentStatus).toBe('unpaid');

    const stored = await prisma.reservation.findUnique({
      where: { id: res.body.reservation.id },
    });
    expect(stored?.status).toBe('confirmed');
    expect(stored?.holdExpiresAt).toBeNull();

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0]).toMatchObject({ payOnArrival: true });
  }, 30_000);
});
