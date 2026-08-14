import { Injectable, Logger } from '@nestjs/common';

export interface Beds24BookingInput {
  propertyId: number;
  roomId: number;
  status: string; // 'confirmed'
  arrival: string; // YYYY-MM-DD
  departure: string; // YYYY-MM-DD
  firstName: string;
  lastName: string;
  email: string;
  numAdult: number;
}

/**
 * Thin HTTP client for Beds24 API v2 (https://api.beds24.com/v2).
 *
 * Auth: a long-life REFRESH token (stored per-tenant in
 * tenant_settings.beds24_api_key) is exchanged for a short-lived ACCESS token
 * via GET /authentication/token (refresh token sent in the `refreshToken`
 * header). API calls then send the access token in the `token` header.
 *
 * POST /bookings sends a booking to Beds24, which closes availability for those
 * dates at all other connected sources (Booking.com/Airbnb) — this is how a
 * direct booking blocks the OTAs.
 */
@Injectable()
export class Beds24Service {
  private readonly logger = new Logger(Beds24Service.name);
  private readonly baseUrl =
    process.env.BEDS24_API_BASE_URL ?? 'https://api.beds24.com/v2';
  // Cache access tokens keyed by refresh token, with expiry.
  private readonly tokenCache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  async getAccessToken(refreshToken: string): Promise<string> {
    const cached = this.tokenCache.get(refreshToken);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      return cached.token;
    }
    const res = await fetch(`${this.baseUrl}/authentication/token`, {
      method: 'GET',
      headers: { refreshToken },
    });
    if (!res.ok) {
      throw new Error(`Beds24 token refresh failed: HTTP ${res.status}`);
    }
    const data = (await res.json()) as { token: string; expiresIn: number };
    this.tokenCache.set(refreshToken, {
      token: data.token,
      expiresAt: Date.now() + (data.expiresIn ?? 0) * 1000,
    });
    return data.token;
  }

  /** POST /bookings — Beds24 accepts an array of bookings. */
  async createBooking(
    refreshToken: string,
    booking: Beds24BookingInput,
  ): Promise<unknown> {
    const token = await this.getAccessToken(refreshToken);
    const res = await fetch(`${this.baseUrl}/bookings`, {
      method: 'POST',
      headers: { token, 'Content-Type': 'application/json' },
      body: JSON.stringify([booking]),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Beds24 POST /bookings failed: HTTP ${res.status} ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }
}
