# VIGÍA — Detector de caídas (sitios, DNS y TLS) en Cloudflare

Guía completa para construir un DownDetector propio con el stack más
rápido que existe hoy: todo en el edge de Cloudflare, sin servidores,
sin frameworks pesados. La página de estado es HTML estático y el
monitoreo corre en 300+ ciudades a la vez.

> Nombre sugerido para el repo: **`vigia`** (o `down-detector` si lo
> quieres en inglés). El resto de la guía usa `vigia`.

---

## 1. Qué detecta

Tres pilares, cada uno con su propio chequeo:

| Pilar | Qué se comprueba | Cómo |
|---|---|---|
| **HTTP** | ¿Responde? ¿Qué código? ¿Cuánto tarda (TTFB y total)? ¿El contenido trae lo esperado? | `fetch()` desde el Worker, midiendo tiempos |
| **DNS** | ¿Resuelven los registros A / AAAA / CNAME / MX / NS? ¿Cambió algún registro? | DNS-over-HTTPS contra `1.1.1.1` |
| **TLS / CA** | ¿El certificado es válido? ¿Cuándo expira? ¿La cadena es correcta? | El `fetch()` falla si el cert es inválido; la expiración se consulta en los logs de transparencia (crt.sh) o con handshake TLS vía Sockets API (avanzado, §6) |

Además: historial de caídas (incidentes con inicio/fin y causa),
página de estado pública, y alertas (webhook, email, Telegram).

---

## 2. El stack (y por qué cada pieza)

Todo corre en Cloudflare. No hay VPS, no hay Docker, no hay servidor
que administrar. El código corre en isolates V8 al borde, con cold
start de ~0 ms.

| Pieza | Tecnología | Por qué |
|---|---|---|
| Compute | **Cloudflare Workers** (TypeScript) | Corre en 300+ ciudades. Un check se ejecuta desde el edge más cercano al usuario, no desde un solo servidor. Para este trabajo (I/O, no CPU) TypeScript es lo óptimo; Rust solo ganaría en CPU, y aquí el cuello es la red |
| Checks programados | **Cron Triggers** | Disparan el scheduler cada 1 min (gratis) |
| Fan-out | **Cloudflare Queues** | El scheduler encola un trabajo por monitor; los probers los consumen en paralelo. Sin esto, un cron se comería todo el límite de CPU de un solo Worker |
| Estado y anti-falsos-positivos | **Durable Objects** | Un objeto por monitor: guarda el estado, decide si una caída es real (exige 2+ fallos seguidos o confirmación desde otra región), y sirve el estado en vivo por WebSocket |
| Historial e incidentes | **D1** (SQLite en el edge) | Base relacional para checks, incidentes y certificados. Lecturas replicadas al borde |
| Estado actual (caliente) | **KV** | El estado "está caído / está bien" de cada monitor, leído en <1 ms por la API pública |
| Métricas y gráficas | **Workers Analytics Engine** | Series de tiempo (latencia p50/p95/p99) sin pegarle a la base de datos |
| Logs a largo plazo | **R2** | Checks viejos archivados, sin costo de salida |
| Frontend | **Workers Static Assets** (o Pages) | La página de estado es HTML estático + un JS mínimo que consulta la API. Cero framework |
| Alertas | **Workers + Email / webhooks** | MailChannels (email saliente en Workers) o un webhook a Telegram/Discord/Slack |

**¿Y Rust?** El stack de arriba ya es el más rápido para este
problema. Rust entra en dos lugares si quieres ir a fondo:
- **Prober en Rust con `workers-rs`** (el SDK oficial de Rust para
  Workers, compila a WASM): útil si el chequeo hace parseo pesado.
- **Inspección TLS real**: con la **Sockets API** (`cloudflare:sockets`)
  puedes abrir un TCP + handshake TLS y leer el certificado directamente
  (fechas, emisor, cadena). Es el camino avanzado; la vía simple es
  crt.sh (§6) y es suficiente para la v1.

---

## 3. Arquitectura

```
                ┌─────────────────────┐
                │  Cron Trigger (1m)  │
                └──────────┬──────────┘
                           ▼
                ┌─────────────────────┐
                │ Scheduler Worker    │  lee monitores activos de D1
                └──────────┬──────────┘
                           ▼  un mensaje por monitor
                ┌─────────────────────┐
                │ Cloudflare Queue    │
                └──────────┬──────────┘
                           ▼  consumidores en paralelo, global
                ┌─────────────────────┐
                │ Prober Worker       │  HTTP + DNS (DoH) + TLS
                └──────────┬──────────┘
                           ▼  resultado del check
   ┌─────────────────────────────────────────────────┐
   │ Durable Object (uno por monitor)                │
   │  - acumula fallos, abre/cierra incidentes       │
   │  - exige confirmación antes de declarar caída   │
   │  - emite estado por WebSocket                   │
   └──────┬──────────────────────┬───────────────────┘
          ▼                      ▼
   ┌────────────┐          ┌────────────┐
   │ D1 (hist.) │          │ KV (estado)│
   └────────────┘          └────────────┘
          │                      │
          └──────────┬───────────┘
                     ▼
   ┌──────────────────────────────────┐
   │ API Worker (con caché edge)      │──▶ Status page (estática)
   └──────────────────────────────────┘
                     │
                     ▼
   ┌──────────────────────────────────┐
   │ Alerter Worker → webhook/email   │
   └──────────────────────────────────┘
```

Flujo de un check: el cron dispara al scheduler → este mete un
trabajo por monitor en la cola → los probers (repartidos por el mundo)
hacen HTTP + DNS + TLS → el resultado va al Durable Object del monitor
→ si hay 2 fallos seguidos (o confirmación en otra región), abre un
incidente en D1, actualiza KV y dispara la alerta.

**Anti-falsos-positivos:** nunca declares caído un sitio por un solo
fallo. Regla: 2 fallos consecutivos desde la misma región, o 1 fallo
confirmado desde una segunda región (otro colo). Los Durable Objects
hacen esto trivial porque guardan el estado entre checks.

---

## 4. Estructura del repo

```
vigia/
├── wrangler.toml          # Workers, Cron, Queues, D1, KV, R2, DO
├── package.json
├── src/
│   ├── scheduler.ts       # cron: lee monitores, encola checks
│   ├── prober.ts          # consumer de la cola: HTTP + DNS + TLS
│   ├── monitor.ts         # Durable Object por monitor
│   ├── api.ts             # API pública: /status, /history, /incidents
│   ├── alerter.ts         # alertas (webhook / email / Telegram)
│   ├── tls.ts             # expiración de certificados (crt.sh + Sockets)
│   └── types.ts
├── migrations/
│   └── 0001_init.sql      # esquema D1
├── public/                # página de estado (HTML + CSS + JS mínimo)
│   └── index.html
└── .github/workflows/
    └── deploy.yml         # CI: typecheck + deploy en cada push a main
```

---

## 5. Setup paso a paso

### 5.1 Repo y proyecto

```bash
# 1. Crea el repo en GitHub (vacío, sin README inicial o con él)
# 2. En tu máquina:
npm create cloudflare@latest vigia -- --type worker --ts
cd vigia
npm install
```

### 5.2 Recursos de Cloudflare (una sola vez)

```bash
npx wrangler login

# Base de datos (historial e incidentes)
npx wrangler d1 create vigia-db
# → anota el database_id y ponlo en wrangler.toml

# KV (estado actual en caliente)
npx wrangler kv namespace create VIGIA_STATUS

# Cola de checks
npx wrangler queues create vigia-checks

# R2 (archivo de logs viejos)
npx wrangler r2 bucket create vigia-archive

# Aplica el esquema
npx wrangler d1 execute vigia-db --file migrations/0001_init.sql
```

### 5.3 `wrangler.toml` (lo esencial)

```toml
name = "vigia"
main = "src/scheduler.ts"
compatibility_date = "2026-11-09"

[triggers]
crons = ["* * * * *"]          # scheduler cada 1 minuto

[[queues.producers]]
queue = "vigia-checks"
binding = "CHECK_QUEUE"

[[queues.consumers]]
queue = "vigia-checks"
max_batch_size = 50

[[durable_objects.bindings]]
name = "MONITOR"
class_name = "Monitor"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Monitor"]

[[d1_databases]]
binding = "DB"
database_name = "vigia-db"
database_id = "<el-que-te-dio-wrangler>"

[[kv_namespaces]]
binding = "STATUS"
id = "<id-del-namespace>"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "vigia-archive"

[analytics_engine_datasets]
binding = "METRICS"
dataset = "vigia_metrics"
```

### 5.4 Deploy

```bash
npx wrangler deploy
# API pública: https://vigia.<tu-subdominio>.workers.dev
# Dominio propio: npx wrangler domains add vigia.tudominio.com
```

### 5.5 CI (GitHub Actions, `.github/workflows/deploy.yml`)

```yaml
name: Deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run typecheck
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## 6. El código clave

### 6.1 Esquema D1 (`migrations/0001_init.sql`)

```sql
CREATE TABLE monitors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  check_interval_s INTEGER NOT NULL DEFAULT 60,
  keyword TEXT,                 -- texto que debe aparecer en el body (opcional)
  expected_status INTEGER NOT NULL DEFAULT 200,
  created_at INTEGER NOT NULL
);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  ts INTEGER NOT NULL,
  region TEXT NOT NULL,         -- colo que hizo el check (cf.colo)
  ok INTEGER NOT NULL,          -- 1 = bien, 0 = fallo
  status_code INTEGER,
  ttfb_ms INTEGER,
  total_ms INTEGER,
  error TEXT
);
CREATE INDEX idx_checks_monitor_ts ON checks(monitor_id, ts);

CREATE TABLE incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id TEXT NOT NULL REFERENCES monitors(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  cause TEXT,                   -- 'http_500' | 'timeout' | 'dns' | 'tls' | ...
  checks_failed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE certs (
  monitor_id TEXT PRIMARY KEY REFERENCES monitors(id),
  issuer TEXT,
  not_after INTEGER,            -- expiración (epoch)
  checked_at INTEGER NOT NULL
);
```

### 6.2 Prober HTTP (lo que corre en el edge)

```ts
// src/prober.ts — consumer de la cola
export async function checkHttp(m: Monitor) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10_000); // timeout 10 s
  try {
    const res = await fetch(m.url, {
      signal: ctrl.signal,
      redirect: "follow",
      cf: { cacheTtl: 0 },              // nunca cachear un check
    });
    const ttfb = Date.now() - t0;
    const body = await res.text();
    const ok =
      res.status === m.expected_status &&
      (!m.keyword || body.includes(m.keyword));
    return { ok, status: res.status, ttfb_ms: ttfb, total_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String(e) }; // timeout, DNS, TLS inválido…
  } finally {
    clearTimeout(to);
  }
}
```

Nota: un certificado TLS inválido o expirado hace que el `fetch()`
falle directamente — eso ya es una señal de caída por TLS, aunque no
te diga la fecha exacta de expiración. Para la fecha, §6.4.

### 6.3 DNS por DNS-over-HTTPS

```ts
// src/prober.ts
async function checkDns(hostname: string, type = "A") {
  const r = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${hostname}&type=${type}`,
    { headers: { accept: "application/dns-json" } }
  );
  const j = await r.json();
  // j.Status === 0 (NOERROR) y j.Answer con las IPs
  return { ok: j.Status === 0 && (j.Answer?.length ?? 0) > 0, answers: j.Answer ?? [] };
}
```

Con esto compruebas A, AAAA, CNAME, MX y NS, y detectas cambios
guardando las respuestas en D1 y comparando en cada check.

### 6.4 Expiración de certificados (TLS / CA)

**Vía simple (v1):** los logs de transparencia de certificados.

```ts
// src/tls.ts
async function checkCertExpiry(hostname: string) {
  const r = await fetch(
    `https://crt.sh/?q=${encodeURIComponent(hostname)}&output=json`
  );
  const certs = await r.json();
  const latest = certs
    .map((c: any) => new Date(c.not_after).getTime())
    .sort((a: number, b: number) => b - a)[0];
  const daysLeft = Math.round((latest - Date.now()) / 86_400_000);
  return { daysLeft, expiresAt: latest, alert: daysLeft < 14 };
}
```

**Vía avanzada (v2):** Sockets API de Cloudflare
(`cloudflare:sockets`): abres un TCP al puerto 443, haces el
handshake TLS y lees el certificado directamente (emisor, cadena,
`not_after`). Sin depender de un tercero. Es el camino "punta de
lanza", pero requiere la API de sockets habilitada en tu cuenta.

### 6.5 Durable Object (la pieza que evita falsos positivos)

```ts
// src/monitor.ts
export class Monitor {
  state: DurableObjectState;
  fails = 0;
  incidentOpen = false;

  async onCheck(result: CheckResult) {
    if (result.ok) {
      this.fails = 0;
      if (this.incidentOpen) await this.closeIncident();
    } else {
      this.fails++;
      // Regla: 2 fallos seguidos = caída real (no un hipo de red)
      if (this.fails >= 2 && !this.incidentOpen) {
        await this.openIncident(result);
        await this.env.STATUS.put(this.id, "down");
        await this.env.CHECK_QUEUE.send({ type: "alert", monitor: this.id });
      }
    }
    // El estado en vivo se sirve por WebSocket desde aquí mismo
  }
}
```

### 6.6 API pública (con caché)

```ts
// src/api.ts
// GET /api/status → lee KV (estado actual), Cache API con
// stale-while-revalidate de 30 s: la página de estado nunca pega
// a D1 en caliente.
// GET /api/history/:id?range=24h → D1, con límite de filas.
// GET /api/incidents → incidentes abiertos y cerrados.
```

---

## 7. Cómo se hace ultra-rápido (lo que lo separa de un UptimeRobot casero)

1. **Nada de servidor de origen.** Todo corre en el edge; el check se
   hace desde la ciudad más cercana al sitio monitoreado.
2. **La API pública nunca toca la base en caliente.** KV + Cache API
   con `stale-while-revalidate`: la página de estado responde en ~1 ms.
3. **Fan-out con colas.** 1,000 monitores no son 1,000 fetch en un
   solo Worker: son 1,000 mensajes que se procesan en paralelo por
   todo el planeta.
4. **Doble confirmación.** Un sitio no se marca caído por un fallo
   aislado: 2 fallos seguidos, o confirmación desde otra región.
5. **Frontend de 0 frameworks.** La status page es HTML + un JS de
   ~2 KB que hace fetch a la API. Sin React, sin build pesado.
6. **Métricas sin base de datos.** Latencia p50/p95/p99 con Analytics
   Engine; las gráficas no cuestan queries.
7. **D1 con réplicas de lectura** y R2 para archivar lo viejo: el
   historial no frena el presente.

---

## 8. Alertas (v1: webhook + email, v2: Telegram)

- **Webhook:** el Alerter hace `POST` a la URL que configure el
  usuario (Discord, Slack, o un endpoint propio).
- **Email:** MailChannels en Workers (hay un binding de email saliente;
  en cuentas nuevas se usa `cloudflare-email` / Email Workers).
- **Telegram:** un `fetch()` al Bot API con el chat id. Es el canal
  más rápido de implementar y el que más se usa para esto.

---

## 9. Roadmap

- **v1 (esta guía):** HTTP + DNS + expiración TLS (crt.sh), página de
  estado, historial en D1, alertas por webhook/Telegram, un check por
  minuto por monitor.
- **v2:** TLS real con Sockets API, checks multi-región con
  confirmación cruzada, keyword/JSON checks, status page con
  WebSocket en vivo, prober en Rust (`workers-rs`) para el parseo
  pesado, y alertas por email.
- **v3:** Monitores públicos (cualquiera puede dar de alta un sitio),
  uptime SLA mensual por monitor, y una API con llaves.

---

## 10. Costos (orden de magnitud)

El plan gratis de Cloudflare cubre el arranque: Workers ~100k
requests/día, Cron Triggers, D1 con millones de lecturas, KV y R2 con
capacidades generosas. Un vigía con cientos de monitores chequeados
cada minuto cabe en el gratis o en el plan de pago más bajo (Workers
Paid, ~$5/mes). El costo real aparece cuando tienes miles de
monitores o quieres retener años de historial — ahí entran R2 y D1 de
pago. Revisa los límites actuales en la página de precios de
Cloudflare antes de prometer un número exacto.

---

## 11. Primeros comandos (resumen)

```bash
npx wrangler login
npx wrangler d1 create vigia-db
npx wrangler kv namespace create VIGIA_STATUS
npx wrangler queues create vigia-checks
npx wrangler r2 bucket create vigia-archive
npx wrangler d1 execute vigia-db --file migrations/0001_init.sql
npx wrangler deploy
```
