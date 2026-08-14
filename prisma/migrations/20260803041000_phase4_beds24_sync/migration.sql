-- Phase 4: Beds24 sync layer (additive only — no changes to base tables' core
-- columns or the anti-double-booking EXCLUDE constraint).

-- CreateEnum
CREATE TYPE "ReservationSource" AS ENUM ('direct', 'beds24');

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "external_booking_id" TEXT,
ADD COLUMN     "source" "ReservationSource" NOT NULL DEFAULT 'direct';

-- AlterTable
ALTER TABLE "rooms" ADD COLUMN     "beds24_room_id" TEXT;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "beds24_prop_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "reservations_external_booking_id_key" ON "reservations"("external_booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_beds24_room_id_key" ON "rooms"("beds24_room_id");
