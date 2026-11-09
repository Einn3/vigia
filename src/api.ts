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
  if (url.pathname === "/api/incidents") return incidentsApi(env);

  if (url.pathname.startsWith("/api/history/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    return historyApi(env, id, url);
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

async function incidentsApi(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM incidents ORDER BY started_at DESC LIMIT 50",
  ).all();
  return Response.json({ incidents: results ?? [] });
}

async function historyApi(env: Env, monitorId: string, url: URL): Promise<Response> {
  const rangeH = Number(url.searchParams.get("rangeH") ?? 24);
  const since = Date.now() - rangeH * 3600_000;
  const { results } = await env.DB.prepare(
    `SELECT ts, ok, status_code, ttfb_ms, total_ms, error
     FROM checks
     WHERE monitor_id = ? AND ts >= ?
     ORDER BY ts DESC LIMIT 500`,
  )
    .bind(monitorId, since)
    .all();
  return Response.json({ monitorId, checks: results ?? [] });
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
  return Response.json({ id }, { status: 201 });
}
