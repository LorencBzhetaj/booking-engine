import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { Beds24Service } from '../src/beds24/beds24.service';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'cm-e2e-pass';

/** Admin cancel + modify (atomic, no double-booking window). */
describe('Phase 3+: admin cancel & modify', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomB = '00000000-0000-0000-0000-0000000000b1'; // Suita Familjare (family)
  const roomA1 = '00000000-0000-0000-0000-0000000000a1';
  const EMAIL = 'cancel-modify-e2e@example.com';

  const auth = (r: request.Test) => r.auth(ADMIN_USER, ADMIN_PASS);

  async function makeReservation(
    roomId: string,
    checkIn: string,
    checkOut: string,
  ) {
    return prisma.reservation.create({
      data: {
        tenantId,
        roomId,
        checkIn: new Date(checkIn),
        checkOut: new Date(checkOut),
        guestName: 'CM Test',
        guestEmail: EMAIL,
        status: 'confirmed',
        paymentStatus: 'unpaid',
        source: 'direct',
        totalPrice: new Prisma.Decimal('220.00'),
      },
    });
  }

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
    jest.spyOn(app.get(Beds24Service), 'createBooking').mockResolvedValue({ ok: true });
    await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
  });

  afterAll(async () => {
    if (prisma) await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
    if (app) await app.close();
  });

  it('cancel frees the dates so they can be booked again', async () => {
    const r = await makeReservation(roomB, '2027-08-10', '2027-08-12');

    await auth(
      request(app.getHttpServer()).post(`/admin/reservations/${r.id}/cancel`),
    ).expect(302);

    const after = await prisma.reservation.findUnique({ where: { id: r.id } });
    expect(after?.status).toBe('cancelled');

    // The freed dates are bookable again (cancelled rows leave the EXCLUDE guard).
    const reuse = await makeReservation(roomB, '2027-08-10', '2027-08-12');
    expect(reuse.id).toBeTruthy();
    await prisma.reservation.delete({ where: { id: reuse.id } });
  });

  it('modify changes dates and recomputes the price', async () => {
    const r = await makeReservation(roomB, '2027-09-01', '2027-09-03');

    const res = await auth(
      request(app.getHttpServer())
        .put(`/admin/reservations/${r.id}`)
        .type('form')
        .send({ roomId: roomB, checkIn: '2027-09-05', checkOut: '2027-09-08' }),
    ).expect(302);
    expect(res.headers.location).toContain('ok=updated');

    const after = await prisma.reservation.findUnique({ where: { id: r.id } });
    expect(after && after.checkIn.toISOString().slice(0, 10)).toBe('2027-09-05');
    expect(after && after.checkOut.toISOString().slice(0, 10)).toBe('2027-09-08');
    // family base 110 × 3 nights = 330
    expect(after?.totalPrice.toFixed(2)).toBe('330.00');
  });

  it('modify is rejected when the new dates overlap another reservation', async () => {
    const a = await makeReservation(roomB, '2027-10-10', '2027-10-12');
    const b = await makeReservation(roomB, '2027-10-20', '2027-10-22');

    const res = await auth(
      request(app.getHttpServer())
        .put(`/admin/reservations/${b.id}`)
        .type('form')
        .send({ roomId: roomB, checkIn: '2027-10-11', checkOut: '2027-10-13' }),
    ).expect(302);
    expect(res.headers.location).toContain('error');

    // b is unchanged.
    const after = await prisma.reservation.findUnique({ where: { id: b.id } });
    expect(after && after.checkIn.toISOString().slice(0, 10)).toBe('2027-10-20');
    await prisma.reservation.deleteMany({ where: { id: { in: [a.id, b.id] } } });
  });

  it('modify can shift onto its own current dates (excludes itself)', async () => {
    const r = await makeReservation(roomB, '2027-11-10', '2027-11-13');

    // Shift by one day — overlaps its OWN old range; must NOT self-conflict.
    const res = await auth(
      request(app.getHttpServer())
        .put(`/admin/reservations/${r.id}`)
        .type('form')
        .send({ roomId: roomB, checkIn: '2027-11-11', checkOut: '2027-11-14' }),
    ).expect(302);
    expect(res.headers.location).toContain('ok=updated');

    const after = await prisma.reservation.findUnique({ where: { id: r.id } });
    expect(after && after.checkIn.toISOString().slice(0, 10)).toBe('2027-11-11');
  });
});
