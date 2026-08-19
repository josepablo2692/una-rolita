import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

// Traduce la tabla `users` de schema.sql a una clase de TypeScript.
// phone_number es la identidad principal (registro progresivo por OTP);
// email es opcional.

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    name: 'phone_number',
    type: 'varchar',
    length: 20,
    unique: true,
    nullable: true,
  })
  phoneNumber!: string | null;

  @Column({ type: 'varchar', length: 150, unique: true, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', name: 'display_name', length: 80, nullable: true })
  displayName!: string | null;

  @Column({ name: 'is_phone_verified', default: false })
  isPhoneVerified!: boolean;

  @Column({
    name: 'password_hash',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  passwordHash!: string | null;

  @Column({ name: 'is_email_verified', default: false })
  isEmailVerified!: boolean;

  @Column({ name: 'free_song_used', default: false })
  freeSongUsed!: boolean;

  @Column({ name: 'marketing_opt_in', default: false })
  marketingOptIn!: boolean;
  // Qué versión de los términos aceptó ESTE usuario, y cuándo. No basta
  // con tener los términos publicados: ante una auditoría hay que poder
  // demostrar qué política aceptó cada cliente, sobre todo la de
  // expiración de créditos (ADR 0006).
  @Column({
    name: 'terms_version_accepted',
    type: 'varchar',
    length: 20,
    nullable: true,
  })
  termsVersionAccepted!: string | null;

  @Column({ name: 'terms_accepted_at', type: 'timestamptz', nullable: true })
  termsAcceptedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
