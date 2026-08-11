# ADR 0004: Métodos de pago duales, arquitectura extensible vía PaymentMethod

## Estado

Aceptado

## Contexto

El modelo original de créditos asumía un único flujo de cobro: el
mesero confirma el pago en efectivo/tarjeta y acredita el saldo
manualmente (ver Épica 3 del backlog). Este modelo funciona bien
para bares y clubes con personal de piso, pero no cubre el caso de
un artista solista operando su propio show — no hay mesero, y el
artista necesita cobrar directamente al público, incluyendo
transferencias y pagos con tarjeta sin intermediario humano.

Investigar pasarelas de pago para Guatemala llevó a Recurrente
(API REST, transferencias, checkout, y Tap to Pay para cobrar con
tarjeta desde el celular sin hardware adicional), con una comisión
de 4.5% por transacción. Ese costo, y la complejidad adicional de
manejar webhooks y estados de transacción, hacen que integrar una
pasarela no sea una decisión trivial ni deba ser la única opción
disponible.

Además, surgió la necesidad de diferenciar propinas (dinero sin
contraparte de servicio) de créditos (dinero que compra una acción
en el sistema), que hasta ahora no tenían distinción en el modelo.

## Decisión

Se mantienen ambas modalidades de pago simultáneamente — manual y
vía pasarela — desacopladas detrás de una interfaz común
`PaymentMethod`, siguiendo el mismo patrón Factory Provider ya
usado para `OtpSender` (ver OtpModule). Esto permite:

- El mesero/artista sigue pudiendo confirmar pagos manualmente sin
  ningún proveedor externo involucrado (costo cero, control total).
- Se añade `RecurrentePaymentMethod` como implementación adicional
  de la misma interfaz, sin que el resto del sistema de créditos
  conozca su existencia directamente.
- Las propinas se modelan como una entidad `Tip` separada de
  `Credit`, aunque ambas puedan compartir el mismo `PaymentMethod`
  en un solo checkout (ver desglose en renglones, más abajo).
- Un venue de un solo artista usa el mismo flujo de carga manual que
  ya existe para recepción — el artista actúa como su propio staff
  de caja, sin cambios al modelo de datos.

Cuando un checkout combina más de un concepto (ej. salto de cola +
propina) en una sola transacción externa, internamente se registran
como renglones separados (un `QueueJump` y un `Tip` distintos), cada
uno referenciando el mismo id de transacción externa para trazabilidad.

## Consecuencias

Positivas:

- Ningún venue queda bloqueado por no tener personal de piso.
- Agregar un proveedor de pago nuevo en el futuro (Kash, Qpaypro)
  es una clase nueva implementando `PaymentMethod`, no una
  reescritura del sistema de créditos.
- Los reportes distinguen ingresos por venta de servicio (créditos)
  vs. propinas, relevante también para temas fiscales.

Negativas:

- Mayor complejidad de diseño desde el inicio (interfaz +
  múltiples implementaciones) comparado con solo el flujo manual.
- La comisión de 4.5% de Recurrente reduce el margen cuando se usa
  esa modalidad — decisión de negocio que el venue/artista debe
  conocer al elegir método.
- Manejo de webhooks y estados de transacción fallidos/parciales es
  trabajo adicional no presente en el flujo manual.

## Alternativas consideradas

- **Solo pasarela, eliminar el flujo manual**: descartado — deja
  fuera a venues sin cuenta con proveedor de pagos o que prefieren
  no pagar comisión.
- **POS físico de terceros (MiPOS, Tigo POS) sin integración**:
  descartado como opción única — al no tener API/webhook accesible
  para nuestro backend, esas transacciones quedarían invisibles en
  los reportes del sistema.
