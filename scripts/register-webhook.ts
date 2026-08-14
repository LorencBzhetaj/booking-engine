/**
 * Registers (or reuses) the PayPal webhook for this deployment and writes its id
 * to .env as PAYPAL_WEBHOOK_ID.
 *
 * Uses a FRESH OAuth token from PAYPAL_CLIENT_ID/SECRET (never a hand-copied
 * dashboard token). Run:  npx ts-node scripts/register-webhook.ts
 * Override the public URL with WEBHOOK_URL=... if ngrok changes.
 */
import { config } from 'dotenv';
config();
import * as fs from 'fs';
import * as path from 'path';
import { PayPalService } from '../src/paypal/paypal.service';

const WEBHOOK_URL =
  process.env.WEBHOOK_URL ??
  'https://fled-saint-crinkle.ngrok-free.dev/webhooks/paypal';

const EVENT_TYPES = [
  'CHECKOUT.ORDER.APPROVED',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.DENIED',
];

function apiBase(): string {
  return (process.env.PAYPAL_MODE ?? 'sandbox') === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function writeEnv(webhookId: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  if (/^PAYPAL_WEBHOOK_ID=.*$/m.test(env)) {
    env = env.replace(/^PAYPAL_WEBHOOK_ID=.*$/m, `PAYPAL_WEBHOOK_ID=${webhookId}`);
  } else {
    env += `${env.endsWith('\n') ? '' : '\n'}PAYPAL_WEBHOOK_ID=${webhookId}\n`;
  }
  fs.writeFileSync(envPath, env);
}

async function main() {
  const base = apiBase();
  const token = await new PayPalService().getAccessToken();
  console.log('Got fresh access token from client credentials.');

  const createRes = await fetch(`${base}/v1/notifications/webhooks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: WEBHOOK_URL,
      event_types: EVENT_TYPES.map((name) => ({ name })),
    }),
  });
  const createText = await createRes.text();
  const createData = createText ? JSON.parse(createText) : {};

  let webhookId: string | undefined;

  if (createRes.ok) {
    console.log('Created webhook:\n', JSON.stringify(createData, null, 2));
    webhookId = createData.id;
  } else if (
    createRes.status === 400 &&
    JSON.stringify(createData).toUpperCase().includes('ALREADY')
  ) {
    console.log('Webhook already exists for this URL — fetching existing one…');
    const listRes = await fetch(`${base}/v1/notifications/webhooks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = (await listRes.json()) as {
      webhooks?: { id: string; url: string }[];
    };
    const existing = (list.webhooks ?? []).find((w) => w.url === WEBHOOK_URL);
    if (!existing) {
      console.error('Could not find existing webhook:\n', JSON.stringify(list, null, 2));
      process.exit(1);
    }
    console.log('Existing webhook:\n', JSON.stringify(existing, null, 2));
    webhookId = existing.id;
  } else {
    console.error(`PayPal webhook registration failed: HTTP ${createRes.status}\n${createText}`);
    process.exit(1);
  }

  if (!webhookId) {
    console.error('No webhook id resolved.');
    process.exit(1);
  }

  writeEnv(webhookId);
  console.log(`\n✅ Webhook ID: ${webhookId}`);
  console.log('✅ Written to .env as PAYPAL_WEBHOOK_ID');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
