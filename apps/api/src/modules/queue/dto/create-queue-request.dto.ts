import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsUUID,
  Min,
  MaxLength,
} from 'class-validator';

// Datos mínimos que el cliente manda al pedir una canción. Si la canción
// no existe todavía en el catálogo (Song), el Service la crea al vuelo.

// apps/api/src/modules/queue/dto/create-queue-request.dto.ts
export class CreateQueueRequestDto {
  @IsUUID('4', { message: 'La mesa indicada no es válida' })
  tableId!: string;

  @IsString({ message: 'El identificador de la canción debe ser texto' })
  @MaxLength(100, {
    message: 'El identificador de la canción es demasiado largo',
  })
  songProviderTrackId!: string;

  @IsString({ message: 'El título de la canción debe ser texto' })
  @MaxLength(200, { message: 'El título no puede pasar de 200 caracteres' })
  songTitle!: string;

  @IsString({ message: 'El artista debe ser texto' })
  @MaxLength(200, {
    message: 'El nombre del artista no puede pasar de 200 caracteres',
  })
  songArtist!: string;

  @IsOptional()
  @IsInt({ message: 'La duración debe ser un número entero de milisegundos' })
  @Min(0, { message: 'La duración no puede ser negativa' })
  songDurationMs?: number;

  @IsOptional()
  @IsBoolean({ message: 'El salto de cola debe ser verdadero o falso' })
  isPaidJump?: boolean;
}
