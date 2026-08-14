/**
 * Manual verification of the DB-level anti-double-booking guard.
 * Run: npx ts-node scripts/verify-constraint.ts
 *
 * Proves the EXCLUDE constraint behaves correctly WITHOUT any application-level
 * checking — these are raw inserts straight at the database.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const TENANT = '00000000-0000-0000-0000-000000000001';
const ROOM = '00000000-0000-0000-0000-0000000000a1'; // Dhoma Dopio 1

let pass = 0;
let fail = 0;

function ok(msg: string) {
  console.log(`  ✅ PASS: ${msg}`);
  pass++;
}
function bad(msg: string) {
  console.log(`  ❌ FAIL: ${msg}`);
  fail++;
}

async function insert(
  checkIn: string,
  checkOut: string,
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired',
) {
  return prisma.reservation.create({
    data: {
      tenantId: TENANT,
      roomId: ROOM,
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guestName: 'Test',
      guestEmail: 'test@example.com',
      status,
      totalPrice: new Prisma.Decimal('100.00'),
    },
  });
}

function isExclusionViolation(e: unknown): boolean {
  // Postgres error 23P01 = exclusion_violation. Prisma surfaces it as P2010 raw
  // or as a known error; we match on the message/code defensively.
  const msg = String((e as Error)?.message ?? '');
  return (
    msg.includes('23P01') ||
    msg.includes('exclusion') ||
    msg.includes('no_double_booking')
  );
}

async function main() {
  // Clean slate for this room.
  await prisma.reservation.deleteMany({ where: { roomId: ROOM } });

  // 0. Confirm the constraint actually exists in the catalog.
  const rows = await prisma.$queryRaw<Array<{ conname: string }>>`
    SELECT conname FROM pg_constraint WHERE conname = 'reservations_no_double_booking'
  `;
  if (rows.length === 1) ok('constraint reservations_no_double_booking exists in pg_catalog');
  else bad('constraint NOT found in pg_catalog');

  // 1. Baseline confirmed booking 10–15 Aug.
  await insert('2026-08-10', '2026-08-15', 'confirmed');
  ok('baseline confirmed booking 2026-08-10 → 2026-08-15 inserted');

  // 2. Overlapping booking (12–17) must be REJECTED.
  try {
    await insert('2026-08-12', '2026-08-17', 'pending');
    bad('overlapping 2026-08-12 → 2026-08-17 was ACCEPTED (should be rejected)');
  } catch (e) {
    if (isExclusionViolation(e)) ok('overlapping 2026-08-12 → 2026-08-17 correctly rejected');
    else bad(`overlapping rejected but with unexpected error: ${(e as Error).message}`);
  }

  // 3. Fully-contained overlap (11–14) must be REJECTED.
  try {
    await insert('2026-08-11', '2026-08-14', 'confirmed');
    bad('contained overlap 2026-08-11 → 2026-08-14 was ACCEPTED');
  } catch (e) {
    if (isExclusionViolation(e)) ok('contained overlap 2026-08-11 → 2026-08-14 correctly rejected');
    else bad(`unexpected error: ${(e as Error).message}`);
  }

  // 4. Adjacent booking (15–18): checkout day == check-in day → must be ACCEPTED.
  try {
    await insert('2026-08-15', '2026-08-18', 'confirmed');
    ok('adjacent 2026-08-15 → 2026-08-18 accepted (half-open range, no false conflict)');
  } catch (e) {
    bad(`adjacent booking wrongly rejected: ${(e as Error).message}`);
  }

  // 5. Overlapping but CANCELLED (12–14): excluded from constraint → ACCEPTED.
  try {
    await insert('2026-08-12', '2026-08-14', 'cancelled');
    ok('cancelled overlap 2026-08-12 → 2026-08-14 accepted (not an active status)');
  } catch (e) {
    bad(`cancelled overlap wrongly rejected: ${(e as Error).message}`);
  }

  console.log(`\nResult: ${pass} passed, ${fail} failed`);
  await prisma.reservation.deleteMany({ where: { roomId: ROOM } });
  if (fail > 0) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
