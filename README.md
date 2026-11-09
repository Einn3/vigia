# Vigía

Detector de caídas (sitios, DNS y TLS) en el edge de Cloudflare.
Como un DownDetector propio, sin servidores: todo corre en Workers,
Queues, Durable Objects, D1 y KV, repartido por 300+ ciudades.

- **HTTP**: código de estado, TTFB, tiempo total y keyword opcional.
- **DNS**: registros A (vía DNS-over-HTTPS contra 1.1.1.1).
- **TLS**: expiración del certificado (vía crt.sh; Sockets API en v2).
- **Anti-falsos-positivos**: un sitio no se declara caído por un solo
  fallo; hacen falta 2 fallos seguidos (Durable Object por monitor).
- **Página de estado**: HTML estático, cero framework.
- **Alertas**: webhook y/o Telegram.

La guía completa (arquitectura, decisiones y roadmap) está en
`docs/guia.md` — o pídele la guía a Muse.

## En vivo

- Página de estado: https://vigia.20301063.workers.dev/
- API: https://vigia.20301063.workers.dev/api/status
- Salud: https://vigia.20301063.workers.dev/health

## Quickstart

```bash
npm install

# 1. Login en Cloudflare (una vez)
npx wrangler login

# 2. Crear los recursos (anota los IDs que devuelve cada comando)
npx wrangler d1 create vigia-db
npx wrangler kv namespace create VIGIA_STATUS
npx wrangler queues create vigia-checks

# 3. Poner los IDs en wrangler.toml (donde dice REPLACE_ME)

# 4. Crear el esquema y los monitores de ejemplo
npx wrangler d1 execute vigia-db --file migrations/0001_init.sql
npx wrangler d1 execute vigia-db --file migrations/0002_seed.sql

# 5. Deploy
npm run deploy
```

La API queda en `https://vigia.20301063.workers.dev` y la
página de estado en `/`. Dominio propio:

```bash
npx wrangler domains add vigia.tudominio.com
```

## Agregar un monitor

```bash
curl -X POST https://vigia.<tu-subdominio>.workers.dev/api/monitors \
  -H 'content-type: application/json' \
  -d '{"name": "Mi sitio", "url": "https://misitio.com", "keyword": "Bienvenido"}'
```

Si configuras el secret `ADMIN_TOKEN` (`wrangler secret put ADMIN_TOKEN`),
el endpoint exige `Authorization: Bearer <token>`. Sin él, queda
abierto (modo dev) — ponlo antes de exponer la API.

## Alertas

```bash
wrangler secret put WEBHOOK_URL        # Discord, Slack o endpoint propio
wrangler secret put TELEGRAM_BOT_TOKEN # bot de Telegram
wrangler secret put TELEGRAM_CHAT_ID   # chat o canal destino
```

## Endpoints

| Ruta | Qué hace |
|---|---|
| `GET /` | Página de estado (estática) |
| `GET /health` | `{ ok: true }` |
| `GET /api/status` | Estado actual de todos los monitores (cache 30 s) |
| `GET /api/history/:id?rangeH=24` | Checks recientes de un monitor |
| `GET /api/incidents` | Incidentes abiertos y cerrados |
| `POST /api/monitors` | Alta de monitor |

## Desarrollo local

```bash
npm run dev        # wrangler dev (cron y colas simulados)
npm run typecheck  # tsc --noEmit
```

## Notas de la v1

- La columna `region` de los checks guarda `"edge"`: el consumer de
  la cola no expone el colo. La atribución por región es un ítem de
  la v2 (checks multi-región con confirmación cruzada).
- La expiración TLS se consulta como mucho 1 vez al día por monitor.
- R2 (archivo de logs viejos) se quitó del scaffold en la v1: el código
  aún no archiva nada y Cloudflare pide tarjeta para activarlo. Se
  agrega cuando exista el archivado.
- El plan gratis de Cloudflare cubre el arranque (ver límites
  actuales en su página de precios).

## CI

Cada push a `main` hace typecheck + deploy (`.github/workflows/deploy.yml`).
Necesita el secret `CLOUDFLARE_API_TOKEN` en el repo.
