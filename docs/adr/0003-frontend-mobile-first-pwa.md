# ADR 0003 — Frontend mobile-first y PWA

## Estado
Aceptado

## Contexto
El cliente final (quien escanea el QR en su mesa) accede exclusivamente desde
su teléfono — no existe un escenario realista de uso desde escritorio para
`web-client`. El panel admin/DJ (`admin-panel`) sí puede usarse desde tablet
o escritorio, pero también se beneficia de funcionar bien en móvil (un DJ
moviéndose por el local).

## Decisión
1. **Mobile-first**: todo el diseño de `web-client` y `admin-panel` se
   construye partiendo de la pantalla de celular como base, escalando hacia
   arriba (tablet, escritorio) — nunca al revés.
2. **PWA (Progressive Web App)**: `web-client` se implementa como PWA —
   instalable desde el navegador sin pasar por App Store/Google Play,
   con manifest.json y service worker básico. Reduce la fricción de "descargar
   una app" para un uso de una sola noche.

## Consecuencias
- El stack de frontend (Next.js) soporta PWA de forma nativa con librerías
  como `next-pwa` — no requiere cambiar el framework ya elegido.
- El backend (NestJS) no requiere ningún cambio por esta decisión — PWA y
  mobile-first son responsabilidad exclusiva del frontend.
- Las pruebas manuales y de QA deben priorizarse en viewport móvil primero,
  antes que en escritorio.