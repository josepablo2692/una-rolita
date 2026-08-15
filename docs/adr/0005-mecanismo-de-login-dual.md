# ADR 0005: Mecanismo de login dual (OTP para clientes, contraseña para staff/admin)

## Contexto

El OTP por email, diseñado para clientes ocasionales que escanean un
QR una vez por noche, no es adecuado para staff/admin/DJ que necesitan
acceder repetidamente, todos los días, a menudo bajo presión de
tiempo durante un evento en vivo. Pedirles un código nuevo cada vez
sería fricción innecesaria para alguien que ya es de confianza del
negocio.

## Decisión

Se mantienen dos mecanismos de autenticación separados, ambos
resultando en el mismo tipo de JWT al final:

- Clientes: OTP por email (ya existente, sin cambios).
- Staff/venue_admin/DJ/super_admin: usuario (email) + contraseña,
  hasheada con bcrypt, validada contra `users.password_hash`.

El rol real se resuelve consultando `user_venue_roles` en el momento
del login — no se asume ni se hardcodea.

## Consecuencias

Positivas: acceso rápido para quien trabaja a diario en la plataforma,
sin sacrificar el flujo sin fricción para el cliente ocasional.

Negativas: dos superficies de autenticación que mantener y proteger
(ej. rate limiting de intentos de contraseña, algo que el OTP no
necesitaba de la misma forma). La asignación inicial de contraseña a
un admin/DJ queda pendiente de diseño (Épica 6, panel admin).
