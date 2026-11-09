import type { Env, Monitor } from "./types";

// API pública + página de estado. Todo lo que no es /api/* se sirve
// desde los assets estáticos (public/index.html).
export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") return Response.json({ ok: true });

  if (url.pathname === "/api/status") return statusApi(request, env, ctx);
  if (url.pathname === "/api/incidents") return incidentsApi(request, env, ctx);

  if (url.pathname.startsWith("/api/history/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return historyApi(request, env, ctx, id, url);
  }

  if (url.pathname === "/api/monitors" && request.method === "POST") {
    return createMonitor(request, env);
  }

  if (url.pathname.startsWith("/api/")) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  return env.ASSETS.fetch(request);
}

// Estado actual de todos los monitores. Se cachea en el edge 30 s
// (stale-while-revalidate 60 s): la página de estado nunca pega a D1
// en caliente.
async function statusApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    "SELECT id, name, url FROM monitors ORDER BY name",
  ).all<Pick<Monitor, "id" | "name" | "url">>();

  const items = [];
  for (const m of results ?? []) {
    const status = (await env.STATUS.get(`monitor:${m.id}`)) ?? "unknown";
    items.push({ ...m, status });
  }

  const res = Response.json(
    { monitors: items, generatedAt: Date.now() },
    { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" } },
  );
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// Incidentes recientes. Se cachea en el edge 60 s: los incidentes
// cambian poco (se abren/cierran), no tiene sentido pegar a D1 en
// cada request de la página de estado.
async function incidentsApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    "SELECT * FROM incidents ORDER BY started_at DESC LIMIT 50",
  ).all();
  const res = Response.json(
    { incidents: results ?? [] },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=60" } },
  );
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// Historial de checks de un monitor. El límite se deriva del rango:
// el scheduler corre como mucho una vez por minuto, así que 24 h son
// 1.440 checks; antes el LIMIT fijo de 500 devolvía solo ~8 h aunque
// se pidieran 24 h. El rango se limita a 7 días. Se cachea en el
// edge 60 s (los checks nuevos llegan cada minuto).
async function historyApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  monitorId: string,
  url: URL,
): Promise<Response> {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return cached;

  const rawH = Number(url.searchParams.get("rangeH") ?? 24);
  const rangeH = Math.min(Math.max(Number.isFinite(rawH) ? rawH : 24, 1), 168);
  const since = Date.now() - rangeH * 3600_000;
  // Un check por minuto como mucho: rangeH horas = rangeH*60 checks.
  // +60 de margen por el redondeo del cron.
  const limit = rangeH * 60 + 60;
  const { results } = await env.DB.prepare(
    `SELECT ts, ok, status_code, ttfb_ms, total_ms, error
     FROM checks
     WHERE monitor_id = ? AND ts >= ?
     ORDER BY ts DESC LIMIT ?`,
  )
    .bind(monitorId, since, limit)
    .all();
  const res = Response.json(
    { monitorId, rangeH, checks: results ?? [] },
    { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=60" } },
  );
  ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// Alta de monitores. Si ADMIN_TOKEN está configurado (secret), exige
// `Authorization: Bearer <token>`; si no, queda abierto (modo dev).
async function createMonitor(request: Request, env: Env): Promise<Response> {
  if (env.ADMIN_TOKEN) {
    if (request.headers.get("authorization") !== `Bearer ${env.ADMIN_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
  }
  const body = (await request.json()) as {
    name: string;
    url: string;
    keyword?: string;
    expected_status?: number;
    check_interval_s?: number;
  };
  if (!body?.name || !body?.url) {
    return Response.json({ error: "name and url are required" }, { status: 400 });
  }
  const id = body.url
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  // El id sale de la URL: http://example.com y https://example.com
  // colisionan en "example-com". Antes el INSERT reventaba con un 500
  // sin explicar nada; ahora se devuelve un 409 claro con el monitor
  // que ya ocupa ese id.
  const existing = await env.DB.prepare("SELECT id, url FROM monitors WHERE id = ?")
    .bind(id)
    .first<{ id: string; url: string }>();
  if (existing) {
    return Response.json(
      { error: "monitor id already exists", id, existing_url: existing.url },
      { status: 409 },
    );
  }
  try {
    await env.DB.prepare(
      `INSERT INTO monitors (id, name, url, check_interval_s, keyword, expected_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        body.name,
        body.url,
        body.check_interval_s ?? 60,
        body.keyword ?? null,
        body.expected_status ?? 200,
        Date.now(),
      )
      .run();
  } catch {
    // Carrera: otro request creó el mismo id entre el SELECT y el INSERT.
    return Response.json({ error: "monitor id already exists", id }, { status: 409 });
  }
  return Response.json({ id }, { status: 201 });
}
