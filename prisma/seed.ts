import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Minimal seed: one tenant (Villa Gjecaj), its settings, a couple of rooms and
// a high-season rule. Enough to exercise availability/pricing manually.
async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: '00000000-0000-0000-0000-000000000001' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Villa Gjecaj',
      timezone: 'Europe/Tirane',
      currency: 'EUR',
      settings: {
        create: {
          taxRate: '0.0000',
          holdDurationMinutes: 30,
          defaultMinStay: 1,
          emailFrom: 'Villa Gjecaj <no-reply@gjecaj.al>',
        },
      },
    },
  });

  // Ensure settings exist / are up to date even when the tenant already existed.
  await prisma.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    update: { emailFrom: 'Villa Gjecaj <no-reply@gjecaj.al>' },
    create: {
      tenantId: tenant.id,
      taxRate: '0.0000',
      holdDurationMinutes: 30,
      defaultMinStay: 1,
      emailFrom: 'Villa Gjecaj <no-reply@gjecaj.al>',
    },
  });

  const rooms = [
    { id: '00000000-0000-0000-0000-0000000000a1', name: 'Dhoma Dopio 1', roomType: 'double', capacity: 2, basePrice: '60.00' },
    { id: '00000000-0000-0000-0000-0000000000a2', name: 'Dhoma Dopio 2', roomType: 'double', capacity: 2, basePrice: '60.00' },
    { id: '00000000-0000-0000-0000-0000000000b1', name: 'Suita Familjare', roomType: 'family', capacity: 4, basePrice: '110.00' },
    { id: '00000000-0000-0000-0000-0000000000c1', name: 'Alpine Chalet', roomType: 'chalet', capacity: 3, basePrice: '90.00' },
  ];

  for (const r of rooms) {
    await prisma.room.upsert({
      where: { id: r.id },
      update: {},
      create: { ...r, tenantId: tenant.id },
    });
  }

  await prisma.season.upsert({
    where: { id: '00000000-0000-0000-0000-0000000000c1' },
    update: {},
    create: {
      id: '00000000-0000-0000-0000-0000000000c1',
      tenantId: tenant.id,
      roomType: 'double',
      name: 'Sezoni i lartë (verë)',
      startDate: new Date('2026-07-01'),
      endDate: new Date('2026-08-31'),
      priceModifier: '1.400',
      minStay: 2,
      maxStay: 21,
    },
  });

  console.log('Seed complete for tenant:', tenant.name);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
