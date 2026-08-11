import { IsString, MaxLength } from 'class-validator';

export class CreateVenueTableDto {
  @IsString()
  @MaxLength(20)
  label!: string; // ej. "Mesa 7"
}
