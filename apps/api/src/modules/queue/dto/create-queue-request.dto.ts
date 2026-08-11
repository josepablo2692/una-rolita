import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  Min,
  MaxLength,
} from 'class-validator';

// Datos mínimos que el cliente manda al pedir una canción. Si la canción
// no existe todavía en el catálogo (Song), el Service la crea al vuelo.

export class CreateQueueRequestDto {
  @IsString()
  @MaxLength(100)
  songProviderTrackId!: string;

  @IsString()
  @MaxLength(200)
  songTitle!: string;

  @IsString()
  @MaxLength(200)
  songArtist!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  songDurationMs?: number;

  @IsOptional()
  @IsBoolean()
  isPaidJump?: boolean;
}
