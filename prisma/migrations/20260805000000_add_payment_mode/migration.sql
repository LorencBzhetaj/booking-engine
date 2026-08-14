-- Pay-on-arrival support (additive). Direct bookings default to confirming
-- immediately with the guest paying at the property; flip to 'prepaid' per
-- tenant once an online payment gateway is wired up.
ALTER TABLE "tenant_settings" ADD COLUMN     "payment_mode" TEXT NOT NULL DEFAULT 'on_arrival';
