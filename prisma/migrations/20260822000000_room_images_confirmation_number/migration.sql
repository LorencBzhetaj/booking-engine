-- Additive: room photo/amenities + human-readable reservation confirmation number.
ALTER TABLE "reservations" ADD COLUMN     "confirmation_number" TEXT;
ALTER TABLE "rooms" ADD COLUMN     "amenities" TEXT,
ADD COLUMN     "image_url" TEXT;
CREATE UNIQUE INDEX "reservations_confirmation_number_key" ON "reservations"("confirmation_number");
