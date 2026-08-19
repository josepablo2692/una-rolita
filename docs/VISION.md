# Visión — Una Rolita más allá de la v1

Creado: 18 de agosto 2026

## Para qué existe este documento

`docs/backlog.md` es el **plan de entrega**: lo que se construye, en orden,
con fecha. Este documento es otra cosa: **ideas de producto que todavía no
son plan.**

Están separadas a propósito. Cuando una visión vive dentro del backlog,
todo empieza a parecer urgente y el equipo pierde el hilo de lo que
realmente hay que entregar. Aquí las ideas están seguras, escritas y
fuera del camino.

**Nada de este documento se construye antes del lanzamiento.** Se revisa
después, con clientes reales usando el producto y diciéndonos qué falta.

---

## 1. El artista en cualquier lugar — "el Uber de las canciones"

### La idea

Hoy Una Rolita asume un **local fijo**: un bar con mesas, QR pegados,
personal, recepción. Pero el valor real no está en el local — está en
**alguien que toca música y alguien que quiere pedirle una canción**.

Un guitarrista en una plaza. Un DJ en una fiesta privada. Un saxofonista
en un restaurante que no es cliente. Cualquiera con un instrumento se
registra, arma su repertorio, muestra un QR, y quien pase puede pedirle
una rola y pagarle.

El paralelo con Uber es exacto en un punto: **Uber no tiene carros.**
Nosotros no tendríamos locales. Lo que se vende es la capa que hace que
la transacción ocurra entre dos desconocidos.

### Por qué es un producto distinto y no una función más

| | Local fijo (v1) | Artista móvil |
|---|---|---|
| Dónde ocurre | Un lugar con dirección | Donde el artista esté ese día |
| Quién cobra | El dueño del local | El artista |
| Cómo entra el dinero | Efectivo en recepción + créditos | Directo del cliente al artista |
| Identificación | QR pegado en la mesa | QR que el artista muestra |
| Duración | Permanente | Una noche, un rato |

La diferencia que más pesa: **en el modelo móvil no hay recepción**, y la
recepción es hoy la única forma de que entre dinero. Ahí el pago tiene
que ser digital de punta a punta.

### Lo que ya está preparado sin haberlo planeado

- **"Venue de artista solista"** ya es un concepto del proyecto: un venue
  donde el artista es su propio admin. Un evento sería un venue efímero.
- El **libro mayor** no sabe nada de locales físicos; solo de cuentas.
- El **`PaymentMethod`** como interfaz (ADR 0004) permite agregar cobro
  digital sin tocar la lógica del negocio.

### Lo que faltaría

- **Venues efímeros**: se crean para una noche y se archivan. Hoy un venue
  es permanente.
- **Ubicación**: el artista publica dónde está tocando ahora.
- **Cobro digital obligatorio**: sin recepción, no hay efectivo posible.
- **Reputación**: en un local fijo el bar responde por el servicio. En la
  calle, ¿quién responde si el artista cobra y no toca? Es el problema
  más difícil del modelo, y es de confianza, no de software.
- **Modelo de comisión distinto**: aquí sí conviene un porcentaje, porque
  el dinero **sí** pasa por nuestros rieles.

---

## 2. Alertas por cercanía

### La idea

Un usuario ya registrado camina cerca de un bar que usa Una Rolita, o
cerca de un artista tocando, y recibe un aviso: *"El Bar La Rolita está a
una cuadra — pedí tu canción"*.

Es adquisición pasiva: convierte gente que pasa en clientes sin que nadie
reparta volantes.

### Lo que hay que resolver antes de construirlo

- **Permiso de ubicación en segundo plano.** Es de los permisos que más
  gente rechaza, y las tiendas de aplicaciones lo revisan con lupa. Una
  PWA tiene aún más limitaciones que una app nativa.
- **Batería.** El seguimiento continuo de ubicación consume mucho. Mal
  hecho, el usuario desinstala.
- **Notificaciones push en PWA.** Verificar soporte real en iOS antes de
  contar con esto — históricamente ha sido el limitante.
- **Frecuencia.** Un aviso útil es uno; tres por semana es spam y termina
  con el permiso revocado.
- **Privacidad.** Guardar el recorrido de una persona es un pasivo legal.
  Lo correcto es evaluar la cercanía **en el dispositivo** y no enviar
  ubicaciones al servidor.

### Alternativa más barata que vale la pena probar primero

Antes de geolocalización: **avisar por horario y hábito.** "Los viernes
solés ir al Bar La Rolita — hoy toca banda en vivo". No necesita permisos
de ubicación, ni batería, ni revisión de tiendas, y probablemente
convierte parecido. Si eso no funciona, la geolocalización tampoco.

---

## 3. Cobro recurrente de la membresía

> Nota: la mecánica de facturación ya está esbozada en
> `backlog.md` → Épica 10. Aquí solo va la parte de visión.

La idea es que la mensualidad se cobre sola a la tarjeta del local, y que
la falta de pago suspenda el servicio automáticamente.

**Lo que hay que entender antes de diseñarlo:**

- **Nunca guardar tarjetas.** La pasarela las tokeniza y nosotros
  guardamos el token, jamás el número. Almacenar tarjetas implica
  cumplimiento PCI, que es un mundo entero.
- **Verificar si Recurrente soporta suscripciones** o solo cobros
  únicos. Si solo hace cobros únicos, el ciclo lo tenemos que orquestar
  nosotros con un job programado.
- **Los cobros fallan seguido** — tarjetas vencidas, sin fondos, bloqueos
  del banco. Se necesita una política de reintentos y avisos antes de
  cortar el servicio.
- **Cortar el servicio es una decisión de negocio, no técnica.** ¿Se apaga
  la cola un viernes a las 11 de la noche porque no pagaron el martes?
  Probablemente no. Hay que definir el período de gracia.

**Y una advertencia de secuencia:** esto no se construye hasta saber
cuánto cobrar, y eso no se sabe hasta tener tres locales en marcha. Un
sistema de cobro automático para un precio que todavía no existe es
trabajo tirado.

---

## 4. Ideas menores anotadas

- **Voz del artista en vivo para dedicatorias.** El esquema ya tiene
  `dedications.delivery_method` con `dj_voice`, `synth_voice` y
  `screen_only`. Falta el caso del **cantante en vivo**: en un local de
  música en vivo no hay DJ, hay artista, y `dj_voice` confunde. Evaluar
  renombrar a `live_voice` o agregar `artist_voice`.
- **Repertorio portátil del artista.** Ya está en el proyecto la idea de
  que la playlist pertenece al perfil del artista y no al local. Encaja
  directamente con el modelo móvil de la sección 1.

---

## Sobre la arquitectura: ¿monolito o microservicios?

Hoy el proyecto es un **monolito modular**: una sola aplicación NestJS,
un solo despliegue, una sola base — pero dividida en módulos con fronteras
claras (`auth`, `venues`, `queue`, `credits`).

**Y así debe quedarse por bastante tiempo.** Microservicios resuelven
problemas que todavía no tenemos: equipos grandes pisándose, partes del
sistema con cargas muy distintas, despliegues independientes. A cambio
cobran caro desde el primer día: red entre servicios, transacciones
distribuidas, observabilidad, orquestación.

Y hay un detalle que lo vuelve inviable aquí: **la transacción de base de
datos que protege el cobro de créditos solo funciona porque cola y
créditos comparten la misma base.** Separarlos en servicios convertiría
un `BEGIN...COMMIT` de diez líneas en un patrón Saga con compensaciones —
mucho más código, mucho más frágil, para el módulo que maneja el dinero.

**La buena noticia:** los módulos que estamos construyendo, con sus
fronteras limpias, son exactamente lo que permite separarlos el día que
haga falta. Un monolito bien modularizado es el camino natural hacia
microservicios; uno mal hecho no se puede partir nunca.

La señal de que llegó el momento no es el tamaño del código: es cuando
una parte del sistema necesite escalar por separado, o cuando haya varios
equipos estorbándose. Ninguna de las dos está cerca.
