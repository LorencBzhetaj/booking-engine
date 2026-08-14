import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export interface CreateOrderParams {
  amount: string; // e.g. "270.00"
  currency: string; // e.g. "EUR"
  reservationId: string; // stored as custom_id + reference_id
  description?: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface PayPalWebhookHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

// CRC32 (IEEE) of the raw body, as an unsigned int — part of PayPal's signed message.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * PayPal REST API v2 client (Orders + webhook verification).
 *
 * Auth: OAuth2 client-credentials (global PAYPAL_CLIENT_ID/SECRET) -> access
 * token. POST /v2/checkout/orders creates an order and returns an "approve"
 * link to redirect the payer. Webhook signatures are verified OFFLINE with
 * SHA256withRSA over `transmissionId|transmissionTime|webhookId|crc32(body)`
 * using the certificate from Paypal-Cert-Url — the same real-crypto approach as
 * the old Stripe integration (no verification-API round-trip).
 */
@Injectable()
export class PayPalService {
  private readonly logger = new Logger(PayPalService.name);
  private readonly mode = process.env.PAYPAL_MODE ?? 'sandbox';
  private readonly baseUrl =
    this.mode === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';

  private token?: { value: string; expiresAt: number };
  private readonly certCache = new Map<string, string>();

  private creds(): { id: string; secret: string } {
    const id = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!id || !secret) throw new Error('PayPal credentials are not configured');
    return { id, secret };
  }

  async getAccessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const { id, secret } = this.creds();
    const basic = Buffer.from(`${id}:${secret}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`PayPal token failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  async createOrder(
    p: CreateOrderParams,
  ): Promise<{ id: string; approveUrl: string }> {
    const token = await this.getAccessToken();
    const res = await fetch(`${this.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': p.reservationId, // idempotency
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: p.reservationId,
            custom_id: p.reservationId,
            description: p.description,
            amount: { currency_code: p.currency, value: p.amount },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: p.returnUrl,
              cancel_url: p.cancelUrl,
              user_action: 'PAY_NOW',
            },
          },
        },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PayPal create order failed: HTTP ${res.status} ${text}`);
    }
    const data = JSON.parse(text) as {
      id: string;
      links?: { rel: string; href: string }[];
    };
    const approve = data.links?.find(
      (l) => l.rel === 'approve' || l.rel === 'payer-action',
    );
    if (!approve) {
      throw new Error('PayPal: no approve link in order response');
    }
    return { id: data.id, approveUrl: approve.href };
  }

  /** Captures an APPROVED order so it completes (fires CHECKOUT.ORDER.COMPLETED). */
  async captureOrder(orderId: string): Promise<unknown> {
    const token = await this.getAccessToken();
    const res = await fetch(
      `${this.baseUrl}/v2/checkout/orders/${orderId}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`PayPal capture failed: HTTP ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Downloads (and caches) the signing certificate. Overridable in tests. */
  protected async fetchCert(certUrl: string): Promise<string> {
    const cached = this.certCache.get(certUrl);
    if (cached) return cached;
    const res = await fetch(certUrl);
    if (!res.ok) throw new Error(`PayPal cert fetch failed: HTTP ${res.status}`);
    const pem = await res.text();
    this.certCache.set(certUrl, pem);
    return pem;
  }

  async verifyWebhookSignature(
    headers: PayPalWebhookHeaders,
    rawBody: Buffer,
    webhookId: string,
  ): Promise<boolean> {
    try {
      const certPem = await this.fetchCert(headers.certUrl);
      const publicKey = this.toPublicKey(certPem);
      const expected = `${headers.transmissionId}|${headers.transmissionTime}|${webhookId}|${crc32(rawBody)}`;
      const verifier = crypto.createVerify('sha256'); // SHA256withRSA
      verifier.update(expected);
      verifier.end();
      return verifier.verify(publicKey, headers.transmissionSig, 'base64');
    } catch (e) {
      this.logger.warn(`PayPal signature verification error: ${String(e)}`);
      return false;
    }
  }

  private toPublicKey(pem: string): crypto.KeyObject {
    try {
      return new crypto.X509Certificate(pem).publicKey;
    } catch {
      return crypto.createPublicKey(pem);
    }
  }
}
