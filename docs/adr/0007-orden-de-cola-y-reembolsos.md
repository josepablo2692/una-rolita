# ADR 0007 — Orden de la cola pagada y política de reembolso

- **Estado:** Aceptado
- **Fecha:** 2026-08-19
- **Relacionado:** ADR 0006 (libro mayor de créditos)

## Contexto

Al simular una cola de 50 pedidos apareció un defecto grave en
`calculateJumpPosition`: todos los saltos pagados iban a
`playing.position + 1`, es decir, **cada salto nuevo se metía adelante de
todos los saltos anteriores**.

Consecuencia con números reales (salto Q5, canción ~3.5 min):

| Hora  | Quién pagó | Posición de María |
| ----- | ---------- | ----------------- |
| 21:10 | María      | 2                 |
| 21:15 | Pedro      | 3                 |
| 21:22 | Ana        | 4                 |
| ...   | 7 más      | **11**            |

María pagó por la posición 2 y terminó en la 11: de 3 minutos de espera a 35. Y el defecto empeora **cuanto mejor le va al negocio**: mientras más
saltos se venden, peor queda quien compró primero.

Eso vuelve injusta la regla de reembolso. El fundamento de no devolver el
salto al cancelar es _"ya recibiste la posición que compraste"_ — pero no
la recibió, se la quitaron. El reclamo sería legítimo:

> "Pagué Q5 para saltarme la fila, me metieron 9 personas adelante,
> cancelé y no me devolvieron nada."

## Decisión

### 1. FIFO entre saltos pagados

Un salto nuevo se coloca **después del último salto pagado que sigue en
cola**, y antes de los pedidos normales. Solo si no hay ningún salto
esperando, va justo después de lo que está sonando.
