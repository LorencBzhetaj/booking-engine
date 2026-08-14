import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as crypto from 'crypto';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PayPalService, crc32 } from '../src/paypal/paypal.service';
import { EmailService } from '../src/email/email.service';
import { Beds24Service } from '../src/beds24/beds24.service';
import { ReservationExpiryService } from '../src/scheduling/reservation-expiry.service';

const WEBHOOK_ID = 'WH-TEST-PAYPAL-E2E';

/**
 * Phase 2 (now PayPal) end-to-end, in-process:
 *   book (pending) -> checkout-session (PayPal order) -> simulated
 *   CHECKOUT.ORDER.COMPLETED webhook with a VALID signature -> confirmed/paid
 *   + email sent once -> duplicate webhook is a no-op.
 * PayPal's network calls are stubbed; the webhook SIGNATURE is verified for real
 * (RSA-SHA256 over transmissionId|time|webhookId|crc32(body)).
 */
describe('Phase 2: PayPal checkout -> webhook -> confirm -> email (idempotent)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let emailSpy: jest.SpyInstance;
  let origPaymentMode: string;

  // Test signing keypair — stands in for PayPal's cert (fetchCert is stubbed).
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomId = '00000000-0000-0000-0000-0000000000a2'; // Dhoma Dopio 2
  const checkIn = '2026-11-05';
  const checkOut = '2026-11-08';

  beforeAll(async () => {
    process.env.PAYPAL_WEBHOOK_ID = WEBHOOK_ID;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);

    const paypal = app.get(PayPalService);
    // Stub the network calls (order creation + capture) — no real PayPal API.
    jest.spyOn(paypal, 'createOrder').mockResolvedValue({
      id: 'PAY-ORDER-123',
      approveUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PAYORDER123',
    });
    jest
      .spyOn(paypal, 'captureOrder')
      .mockResolvedValue({ status: 'COMPLETED' });
    // Stub cert download so verification runs REAL crypto against our test key.
    jest
      .spyOn(paypal as unknown as { fetchCert: (u: string) => Promise<string> }, 'fetchCert')
      .mockResolvedValue(publicKey);

    // Never hit the real Beds24 API when a confirmed direct booking pushes out.
    jest
      .spyOn(app.get(Beds24Service), 'createBooking')
      .mockResolvedValue({ ok: true });

    emailSpy = jest
      .spyOn(app.get(EmailService), 'sendBookingConfirmation')
      .mockResolvedValue(undefined);

    // This suite exercises the PREPAID flow (pending -> pay -> confirmed), so
    // put the tenant in 'prepaid' mode and restore it afterwards.
    const s = await prisma.tenantSettings.findUnique({ where: { tenantId } });
    origPaymentMode = s?.paymentMode ?? 'on_arrival';
    await prisma.tenantSettings.update({
      where: { tenantId },
      data: { paymentMode: 'prepaid' },
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

  function signedWebhook(reservationId: string): {
    payload: string;
    headers: Record<string, string>;
  } {
    const event = {
      id: 'WH-EVT-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: 'CAPTURE-123',
        status: 'COMPLETED',
        custom_id: reservationId, // capture resources carry custom_id directly
      },
    };
    const payload = JSON.stringify(event);
    const transmissionId = 'txn-' + Date.now();
    const transmissionTime = new Date().toISOString();
    const signedString = `${transmissionId}|${transmissionTime}|${WEBHOOK_ID}|${crc32(
      Buffer.from(payload),
    )}`;
    const signature = crypto
      .sign('sha256', Buffer.from(signedString), privateKey)
      .toString('base64');
    return {
      payload,
      headers: {
        'Content-Type': 'application/json',
        'Paypal-Transmission-Id': transmissionId,
        'Paypal-Transmission-Time': transmissionTime,
        'Paypal-Transmission-Sig': signature,
        'Paypal-Cert-Url': 'https://mock.paypal.com/cert.pem',
        'Paypal-Auth-Algo': 'SHA256withRSA',
      },
    };
  }

  it('runs the full flow and is idempotent on duplicate webhooks', async () => {
    const server = app.getHttpServer();

    // 1) pending reservation
    const bookingRes = await request(server)
      .post('/bookings')
      .send({
        tenantId,
        roomId,
        checkIn,
        checkOut,
        guestName: 'Blerim Krasniqi',
        guestEmail: 'blerim@example.com',
      })
      .expect(201);
    const reservationId = bookingRes.body.reservation.id;
    expect(bookingRes.body.reservation.status).toBe('pending');

    // 2) PayPal order (network stubbed) -> approve URL
    const checkoutRes = await request(server)
      .post(`/bookings/${reservationId}/checkout-session`)
      .expect(200);
    expect(checkoutRes.body.url).toContain('paypal.com');

    // 3) first webhook, valid signature
    const wh = signedWebhook(reservationId);
    await request(server)
      .post('/webhooks/paypal')
      .set(wh.headers)
      .send(wh.payload)
      .expect(200);

    // 4) confirmed + paid, email once
    const afterFirst = await prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    expect(afterFirst?.status).toBe('confirmed');
    expect(afterFirst?.paymentStatus).toBe('paid');
    expect(emailSpy).toHaveBeenCalledTimes(1);

    // 5) duplicate webhook -> no change, no second email
    const wh2 = signedWebhook(reservationId);
    await request(server)
      .post('/webhooks/paypal')
      .set(wh2.headers)
      .send(wh2.payload)
      .expect(200);

    const afterSecond = await prisma.reservation.findUnique({
      where: { id: reservationId },
    });
    expect(afterSecond?.status).toBe('confirmed');
    expect(emailSpy).toHaveBeenCalledTimes(1); // STILL once

    // bad signature -> 400, nothing changes
    await request(server)
      .post('/webhooks/paypal')
      .set({ ...wh.headers, 'Paypal-Transmission-Sig': 'AAAA' })
      .send(wh.payload)
      .expect(400);
  }, 60_000);

  it('inline capture (JS SDK onApprove) captures + confirms the reservation', async () => {
    const server = app.getHttpServer();

    const bookingRes = await request(server)
      .post('/bookings')
      .send({
        tenantId,
        roomId,
        checkIn: '2026-11-20',
        checkOut: '2026-11-22',
        guestName: 'Inline Capture',
        guestEmail: 'inline@example.com',
      })
      .expect(201);
    const id = bookingRes.body.reservation.id;

    const res = await request(server)
      .post(`/bookings/${id}/capture`)
      .send({ orderId: 'PAY-ORDER-123' })
      .expect(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(res.body.confirmed).toBe(true);

    const r = await prisma.reservation.findUnique({ where: { id } });
    expect(r?.status).toBe('confirmed');
    expect(r?.paymentStatus).toBe('paid');
  }, 30_000);

  it('cron expiry flips only overdue pending holds to expired', async () => {
    const server = app.getHttpServer();
    await prisma.reservation.deleteMany({ where: { roomId } });

    const res = await request(server)
      .post('/bookings')
      .send({
        tenantId,
        roomId,
        checkIn: '2026-12-01',
        checkOut: '2026-12-03',
        guestName: 'Test Hold',
        guestEmail: 'hold@example.com',
      })
      .expect(201);
    const id = res.body.reservation.id;

    await prisma.reservation.update({
      where: { id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });

    const expiry = app.get(ReservationExpiryService);
    const count = await expiry.expirePendingReservations();
    expect(count).toBeGreaterThanOrEqual(1);

    const after = await prisma.reservation.findUnique({ where: { id } });
    expect(after?.status).toBe('expired');
  }, 30_000);
});
