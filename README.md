# LA OLLA DE LA FORTUNA — V2 MULTIJUGADOR

Simulador de subasta estratégica del bienestar laboral para 2–10 equipos.

## Arquitectura
- Node.js + Express
- Socket.IO para tiempo real
- Frontend HTML/CSS/JS sin frameworks
- Estado de la sala en memoria
- Endpoint `/health`
- Exportación CSV desde `/api/room/CODIGO/export`

## Ejecutar localmente
Requiere Node.js:
```bash
npm install
npm start
```
Luego abrir `http://localhost:3000`.

## Publicación gratuita recomendada
Subir esta carpeta a un repositorio de GitHub y desplegarla como **Web Service** en Render:
- Build Command: `npm install`
- Start Command: `npm start`
- El servicio usa automáticamente `process.env.PORT`.

No se requiere instalar nada en el computador del instructor para usar la versión publicada: solo navegador.

## Importante
El estado actual es en memoria. Si el servicio se reinicia, las salas activas y sus resultados se pierden. Para uso institucional con trazabilidad histórica se recomienda añadir una base de datos en una siguiente versión.
