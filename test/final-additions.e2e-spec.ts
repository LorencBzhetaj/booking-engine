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
import { CloudinaryService } from '../src/cloudinary/cloudinary.service';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'final-e2e-pass';
// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('Final additions: search, confirmation #, admin search, image upload', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const a1 = '00000000-0000-0000-0000-0000000000a1';
  const b1 = '00000000-0000-0000-0000-0000000000b1';
  const c1 = '00000000-0000-0000-0000-0000000000c1';
  const EMAIL = 'final-e2e@example.com';
  const auth = (r: request.Test) => r.auth(ADMIN_USER, ADMIN_PASS);

  beforeAll(async () => {
    process.env.ADMIN_USER = ADMIN_USER;
    process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync(ADMIN_PASS, 10);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app as NestExpressApplication);
    await app.init();

    prisma = app.get(PrismaService);
    jest.spyOn(app.get(Beds24Service), 'createBooking').mockResolvedValue({ ok: true });
    jest
      .spyOn(app.get(CloudinaryService), 'uploadImage')
      .mockResolvedValue('https://res.cloudinary.com/test/room.png');
    jest.spyOn(app.get(CloudinaryService), 'isConfigured').mockReturnValue(true);

    await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
      await prisma.room.update({ where: { id: c1 }, data: { imageUrl: null } });
    }
    if (app) await app.close();
  });

  it('date-first search returns available rooms and excludes a booked one', async () => {
    // Book a1 for the window; it must then be absent from the search results.
    await prisma.reservation.create({
      data: {
        tenantId, roomId: a1,
        checkIn: new Date('2027-05-10'), checkOut: new Date('2027-05-12'),
        guestName: 'Blocker', guestEmail: EMAIL, status: 'confirmed',
        paymentStatus: 'unpaid', source: 'direct', totalPrice: new Prisma.Decimal('120'),
      },
    });
    const res = await request(app.getHttpServer())
      .get('/availability/search?tenantId=' + tenantId + '&checkIn=2027-05-10&checkOut=2027-05-12')
      .expect(200);
    const ids = res.body.rooms.map((r: { roomId: string }) => r.roomId);
    expect(ids).not.toContain(a1);
    expect(ids.length).toBeGreaterThan(0);
    const one = res.body.rooms[0];
    expect(one).toHaveProperty('pricePerNight');
    expect(one).toHaveProperty('totalPrice');
    expect(one).toHaveProperty('name');
  });

  it('assigns a RES-YYYY-XXXXXX confirmation number on booking', async () => {
    const res = await request(app.getHttpServer())
      .post('/bookings')
      .send({
        tenantId, roomId: b1, checkIn: '2027-05-20', checkOut: '2027-05-22',
        guestName: 'Code Guest', guestEmail: EMAIL,
      })
      .expect(201);
    const code = res.body.reservation.confirmationNumber;
    expect(code).toMatch(/^RES-\d{4}-[A-Z0-9]{6}$/);

    // Admin search by that code returns the reservation.
    const found = await auth(
      request(app.getHttpServer()).get(`/admin/reservations?q=${code}`),
    ).expect(200);
    expect(found.text).toContain('Code Guest');
    expect(found.text).toContain(code);
  });

  it('admin search matches partial guest name too', async () => {
    const res = await auth(
      request(app.getHttpServer()).get('/admin/reservations?q=Code Gu'),
    ).expect(200);
    expect(res.text).toContain('Code Guest');
  });

  it('uploads a room image (Cloudinary mocked) and stores the URL', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post(`/admin/rooms/${c1}/upload-image`)
        .attach('image', PNG, { filename: 'room.png', contentType: 'image/png' }),
    ).expect(302);
    expect(res.headers.location).toContain('ok=image_uploaded');

    const room = await prisma.room.findUnique({ where: { id: c1 } });
    expect(room?.imageUrl).toBe('https://res.cloudinary.com/test/room.png');
  });

  it('rejects a non-image upload with a clear error', async () => {
    const res = await auth(
      request(app.getHttpServer())
        .post(`/admin/rooms/${c1}/upload-image`)
        .attach('image', Buffer.from('hello'), { filename: 'x.txt', contentType: 'text/plain' }),
    ).expect(302);
    expect(res.headers.location).toContain('error');
    expect(decodeURIComponent(res.headers.location)).toMatch(/JPG|PNG|WEBP/i);
  });
});
