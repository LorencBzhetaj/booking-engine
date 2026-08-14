/**
 * One-time Beds24 API v2 bootstrap: exchange an INVITE CODE for a long-life
 * REFRESH TOKEN and store it in tenant_settings.beds24_api_key.
 *
 * Run it YOURSELF so the secrets never pass through chat:
 *   BEDS24_INVITE_CODE=xxxxx npm run beds24:setup
 *
 * Optional overrides:
 *   BEDS24_API_BASE_URL   (default https://api.beds24.com/v2)
 *
 * The invite code is single-use and expires in 24h, so run this right after
 * generating it in Beds24 (Account → Account Access → Generate invite code).
 */
import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const inviteCode = process.env.BEDS24_INVITE_CODE ?? process.argv[2];
  if (!inviteCode) {
    console.error('Missing invite code. Usage: BEDS24_INVITE_CODE=xxx npm run beds24:setup');
    process.exit(1);
  }
  const base = process.env.BEDS24_API_BASE_URL ?? 'https://api.beds24.com/v2';

  const res = await fetch(`${base}/authentication/setup`, {
    method: 'GET',
    headers: { code: inviteCode, deviceName: 'gjecaj-booking-engine' },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Beds24 setup failed: HTTP ${res.status} ${text}`);
    process.exit(1);
  }
  const data = JSON.parse(text) as {
    token: string;
    expiresIn: number;
    refreshToken: string;
  };
  if (!data.refreshToken) {
    console.error('No refreshToken in response:', text);
    process.exit(1);
  }

  const tenant = await prisma.tenant.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!tenant) {
    console.error('No tenant found. Seed the DB first.');
    process.exit(1);
  }

  await prisma.tenantSettings.update({
    where: { tenantId: tenant.id },
    data: { beds24ApiKey: data.refreshToken },
  });

  console.log('✅ Stored Beds24 refresh token in tenant_settings.beds24_api_key');
  console.log(`   (access token valid ${data.expiresIn}s; refresh token auto-renews on use)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
