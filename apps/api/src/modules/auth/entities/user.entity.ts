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

  @Column({ name: 'is_email_verified', default: false })
  isEmailVerified!: boolean;

  @Column({ name: 'free_song_used', default: false })
  freeSongUsed!: boolean;

  @Column({ name: 'marketing_opt_in', default: false })
  marketingOptIn!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
