import { ValueTransformer } from 'typeorm';

// Postgres devuelve las columnas NUMERIC como string (para no perder
// precisión), pero eso rompe operaciones aritméticas normales en JS
// (ej. 6 + "3.00" concatena en vez de sumar). Este transformer convierte
// automáticamente: al leer de la BD, string -> number; al escribir,
// number -> lo que Postgres espera. Se usa en cualquier columna @Column
// de tipo 'numeric' en cualquier Entity del proyecto.

export class NumericColumnTransformer implements ValueTransformer {
  to(value: number | null): number | null {
    return value;
  }

  from(value: string | null): number | null {
    return value === null ? null : parseFloat(value);
  }
}
