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
const ADMIN_PASS = 'dash-e2e-pass';

describe('Admin dashboard', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const roomB = '00000000-0000-0000-0000-0000000000b1';
  const EMAIL = 'dashboard-e2e@example.com';

  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const twoDays = new Date(today.getTime() + 2 * 86_400_000);

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
    await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
    // An arrival for today on a free room.
    await prisma.reservation.create({
      data: {
        tenantId,
        roomId: roomB,
        checkIn: today,
        checkOut: twoDays,
        guestName: 'Dashboard Arrival',
        guestEmail: EMAIL,
        status: 'confirmed',
        paymentStatus: 'unpaid',
        source: 'direct',
        totalPrice: new Prisma.Decimal('220.00'),
      },
    });
  });

  afterAll(async () => {
    if (prisma) await prisma.reservation.deleteMany({ where: { guestEmail: EMAIL } });
    if (app) await app.close();
  });

  it('requires auth', async () => {
    await request(app.getHttpServer()).get('/admin/dashboard').expect(401);
  });

  it('renders with today’s arrival and occupancy', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/dashboard')
      .auth(ADMIN_USER, ADMIN_PASS)
      .expect(200);
    expect(res.text).toContain('Dashboard Arrival'); // arrival listed for today
    expect(res.text).toContain('Occupancy'); // occupancy section present
    expect(res.text).toContain('room-nights');
  });

  it('/admin root redirects to the dashboard', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin')
      .auth(ADMIN_USER, ADMIN_PASS)
      .expect(302);
    expect(res.headers.location).toBe('/admin/dashboard');
  });
});
