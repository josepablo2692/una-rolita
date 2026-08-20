# ADR 0006 — Libro mayor inmutable para créditos

- **Estado:** Aceptado
- **Fecha:** 2026-08-15
- **Reemplaza:** el modelo de `credit_accounts` / `credit_transactions`
  definido originalmente en `schema.sql`
- **Relacionado:** ADR 0004 (métodos de pago duales)

## Contexto

El esquema original modelaba los créditos como un saldo global por
usuario (`credit_accounts.user_id` como llave primaria) y una tabla de
recargas con `CHECK (amount > 0)`.

Al empezar Épica 3 surgieron cuatro requisitos que ese modelo no puede
satisfacer:

1. **Gastos.** Con `amount > 0` la tabla solo registra entradas de
   dinero. No existe forma de registrar el cobro de una canción.
2. **Reversas sin edición** (backlog L38). Corregir un error de caja
   debe crear un movimiento nuevo, nunca modificar el original.
3. **Reembolso condicionado** (backlog L29/L51). Para decidir si un
   salto se reembolsa hay que saber qué cobros generó cada pedido.
4. **Expiración** (backlog L43). Requiere saber cuándo entró cada
   crédito, no solo cuánto hay.

Además, el saldo global contradice ADR 0004: si los créditos pertenecen
al dueño del venue sin split, un saldo que se gasta en cualquier local
crea un pasivo entre negocios que nadie liquida.

## Decisión

### 1. Libro mayor de solo-anexado (append-only)

`credit_transactions` es inmutable. Nunca se hace `UPDATE` ni `DELETE`.
Corregir un error significa insertar una transacción reversa que
referencia a la original vía `reverses_transaction_id`.

Es el modelo de la contabilidad de partida doble, y la razón es la
auditabilidad: un asiento contable no se borra, se contrasienta.

La inmutabilidad se hace cumplir con un trigger de PostgreSQL, no por
disciplina del equipo. Deja de depender de que todos recuerden la regla.

### 2. Montos con signo

`amount` es un entero con signo: positivo entra, negativo sale.

Esto establece la invariante central del sistema:

    SUM(amount) = credit_accounts.balance

La integridad de todo el módulo de créditos se verifica con una sola
consulta. Es la prueba de integridad de Épica 7 y sale gratis.

### 3. El saldo es caché, no verdad

`credit_accounts.balance` existe solo por rendimiento: sumar el
historial completo en cada request no escala. La verdad es el ledger.
El saldo se puede recomputar y contrastar en cualquier momento.

### 4. Cuenta por par (usuario, venue)

`UNIQUE (user_id, venue_id)`. Un cliente que visita tres locales tiene
tres cuentas independientes. Deriva directamente de ADR 0004.

### 5. Créditos enteros, dinero decimal

El saldo se guarda en `INTEGER` (1 crédito = Q1). El efectivo recibido
se guarda aparte en `NUMERIC(10,2)`.

Motivos: todos los precios del negocio son enteros; elimina de raíz los
bugs de NUMERIC-devuelto-como-string; y no existe media canción, así
que medio crédito no significa nada.

La frontera se hace cumplir con un `CHECK` en `venues` que obliga a que
todos los precios sean enteros. Un solo punto del código convierte
precio a créditos, con guard clause que lanza si el precio no es entero.

### 6. Actualización atómica

Insertar la transacción y actualizar el saldo ocurren en la misma
transacción de base de datos, con `SELECT ... FOR UPDATE` sobre la fila
de la cuenta. Sin ese lock, dos requests concurrentes leen el mismo
saldo y el cliente gasta dos veces el mismo crédito (patrón Unit of
Work, backlog L40).

### 7. El ledger solo registra hechos consumados

Las columnas `status`, `bank_reference`, `receipt_url`, `reviewed_by` y
`reviewed_at` del modelo original se eliminan.

Una transferencia pendiente de confirmación **no es un movimiento de
dinero todavía**; es una solicitud. Meterla en el ledger con
`status = 'pending'` rompe la invariante `SUM(amount) = balance`.

Cuando se retome transferencia directa (backlog L49, en pausa), vivirá
en una tabla aparte de solicitudes que, al aprobarse, genera el asiento
correspondiente en el ledger.

### 8. Expiración por inactividad de cuenta

No expiran créditos individuales; expira el saldo completo de una cuenta
sin movimiento durante `venues.credit_expiry_months` (default 3).

La alternativa —expirar por lote con consumo FIFO— es más precisa pero
requiere una tabla de lotes y asignaciones, y vuelve cada cobro un
bucle con locks sobre múltiples filas. Se descarta por plazo y riesgo
de concurrencia.

La expiración se registra como transacción (`type = 'expiration'`),
nunca como un reseteo silencioso del saldo.

## Consecuencias

**Positivas**

- Auditoría completa: todo movimiento tiene autor, fecha y motivo.
- La integridad se verifica con una consulta.
- La inmutabilidad la garantiza la base, no la convención.
- Migrar a lotes FIFO sigue siendo posible: el historial es completo e
  inmutable, así que la columna `remaining` se puede reconstruir
  replayando el ledger. Con un saldo mutable esa reconstrucción sería
  imposible.

**Negativas**

- `credit_transactions` crece indefinidamente. Habrá que particionar o
  archivar cuando el volumen lo exija.
- El trigger de inmutabilidad hace fallar cualquier `UPDATE`, incluidos
  los que TypeORM pudiera intentar por error. Es intencional, pero hay
  que conocerlo al depurar.
- El `SELECT ... FOR UPDATE` serializa las operaciones sobre una misma
  cuenta. Aceptable: la contención es por cliente individual, no global.
- La expiración por inactividad es menos granular que por lote.

**Requisito legal**

La política de expiración debe estar explícita en los términos y
condiciones aceptados por el usuario. Se registra la versión aceptada
(`users.terms_version_accepted` y `terms_accepted_at`) para poder
demostrar, ante una auditoría, qué política aceptó cada cliente y
cuándo.

**Corrección posterior — orden del ledger**

El replay del ledger que promete este ADR exige un orden estricto, y
`created_at` no lo da: TypeORM lo llena con un `Date` de JavaScript
(milisegundos), así que renglones de una misma operación empatan y el
`ORDER BY` desempata al azar. Se agrega `seq BIGSERIAL UNIQUE`.
**Toda consulta de historial ordena por `seq`, nunca por `created_at`.**

## Alternativas descartadas

- **`balance` mutable en `users`.** Sin historial no hay auditoría, ni
  reversas, ni reembolso condicionado, ni expiración.
- **Lotes FIFO desde el inicio.** Correcto pero desproporcionado para el
  plazo actual; el diseño elegido no cierra esa puerta.
- **Saldo global entre venues.** Contradice ADR 0004 y crea un pasivo
  entre negocios sin mecanismo de liquidación.
