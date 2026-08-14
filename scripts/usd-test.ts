// TEMP diagnostic: create a USD tenant/room, make a pending booking + PayPal
// order in USD, print the approve URL. Delete with usd-test-cleanup.
import { config } from 'dotenv';
config();
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const T = 'usd-test-tenant';
const R = 'usd-test-room';
const BASE = 'http://localhost:3001';

async function main() {
  await prisma.tenant.upsert({
    where: { id: T },
    update: { currency: 'USD' },
    create: {
      id: T,
      name: 'USD Test',
      currency: 'USD',
      settings: {
        create: { emailFrom: 'USD Test <no-reply@test.local>' },
      },
    },
  });
  await prisma.room.upsert({
    where: { id: R },
    update: {},
    create: {
      id: R,
      tenantId: T,
      name: 'USD Room',
      roomType: 'double',
      capacity: 2,
      basePrice: new Prisma.Decimal('100.00'),
    },
  });
  await prisma.reservation.deleteMany({ where: { roomId: R } });

  const bookingRes = await fetch(`${BASE}/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenantId: T,
      roomId: R,
      checkIn: '2026-10-20',
      checkOut: '2026-10-22',
      guestName: 'USD Buyer',
      guestEmail: 'usd-test@example.com',
    }),
  });
  const booking = await bookingRes.json();
  if (!bookingRes.ok) throw new Error('booking failed: ' + JSON.stringify(booking));
  const id = booking.reservation.id;
  console.log('reservation:', id, '| total:', booking.reservation.totalPrice, 'USD');

  const sessRes = await fetch(`${BASE}/bookings/${id}/checkout-session`, {
    method: 'POST',
  });
  const sess = await sessRes.json();
  if (!sessRes.ok) throw new Error('checkout failed: ' + JSON.stringify(sess));
  console.log('APPROVE_URL:', sess.url);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
