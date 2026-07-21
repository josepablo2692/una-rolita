import {
  IsString,
  IsIn,
  IsOptional,
  IsNumber,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  VenueType,
  PlaylistMode,
  PlaybackMode,
} from '../entities/venue.entity';

// DTO = Data Transfer Object. Define la FORMA exacta que deben tener los
// datos que llegan del cliente al crear un venue nuevo. El Pipe de NestJS
// usa esta clase para validar automáticamente antes de que el Controller
// reciba el dato — si algo no cumple, rechaza la petición sin que el
// Controller ni el Service tengan que preocuparse por datos sucios.

export class CreateVenueDto {
  @IsString()
  @MaxLength(150)
  name!: string;

  @IsIn(['bar', 'gym', 'strip_club', 'live_music'])
  type!: VenueType;

  @IsOptional()
  @IsIn(['free', 'curated'])
  playlistMode?: PlaylistMode;

  @IsOptional()
  @IsIn(['spotify_managed', 'dj_manual'])
  playbackMode?: PlaybackMode;

  @IsOptional()
  @IsNumber()
  @Min(0)
  cooldownHours?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  queueJumpPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  dedicationPrice?: number;
}
