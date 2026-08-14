import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

export interface BookingConfirmationEmail {
  to: string;
  /** From address, taken from tenant_settings.email_from (never hardcoded). */
  from: string;
  tenantName: string;
  guestName: string;
  roomName: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD
  totalPrice: string;
  currency: string;
  /** When true, the guest pays at the property (no online payment taken). */
  payOnArrival?: boolean;
}

/**
 * Provider-agnostic email sending. Uses Resend when RESEND_API_KEY is present,
 * otherwise logs to the console so local development is never blocked.
 *
 * The single entry point is sendBookingConfirmation(); swapping providers later
 * only touches this class.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null;

  constructor() {
    const apiKey = process.env.RESEND_API_KEY;
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async sendBookingConfirmation(email: BookingConfirmationEmail): Promise<void> {
    const subject = `Booking confirmed — ${email.tenantName}`;
    const text = this.renderText(email);

    if (!this.resend) {
      this.logger.log(
        `[EMAIL:console] to=${email.to} from=${email.from} subject="${subject}"\n${text}`,
      );
      return;
    }

    const { error } = await this.resend.emails.send({
      from: email.from,
      to: email.to,
      subject,
      text,
    });
    if (error) {
      // Do not throw: a failed confirmation email must not break the webhook
      // (PayPal would retry and we'd risk re-processing). Log for follow-up.
      this.logger.error(`Resend failed for ${email.to}: ${error.message}`);
      return;
    }
    this.logger.log(`Confirmation email sent to ${email.to}`);
  }

  /** Generic operational alert to the hotel operator (e.g. cross-channel clash). */
  async sendAdminAlert(params: {
    to: string;
    from: string;
    subject: string;
    body: string;
  }): Promise<void> {
    if (!this.resend) {
      this.logger.warn(
        `[EMAIL:console][ADMIN ALERT] to=${params.to} subject="${params.subject}"\n${params.body}`,
      );
      return;
    }
    const { error } = await this.resend.emails.send({
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.body,
    });
    if (error) {
      this.logger.error(`Resend admin-alert failed for ${params.to}: ${error.message}`);
    }
  }

  private renderText(e: BookingConfirmationEmail): string {
    return [
      `Hi ${e.guestName},`,
      ``,
      `Your booking at ${e.tenantName} is confirmed.`,
      ``,
      `Room:      ${e.roomName}`,
      `Check-in:  ${e.checkIn}`,
      `Check-out: ${e.checkOut}`,
      `Total:     ${e.totalPrice} ${e.currency}`,
      `Payment:   ${e.payOnArrival ? 'Pay on arrival at the property' : 'Paid'}`,
      ``,
      `Thank you!`,
    ].join('\n');
  }
}
