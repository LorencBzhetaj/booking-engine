import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

// tenant_id / room_id are TEXT columns (not the pg uuid type), so validate as
// non-empty strings rather than strict UUID.
export class CheckAvailabilityDto {
  @IsString()
  @IsNotEmpty()
  tenantId!: string;

  @IsString()
  @IsNotEmpty()
  roomId!: string;

  @IsDateString()
  checkIn!: string;

  @IsDateString()
  checkOut!: string;
}
