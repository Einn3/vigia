import type { CheckResult, Env, Monitor, QueueMessage } from "./types";
import { checkCertExpiry } from "./tls";
import { sendAlert } from "./alerter";

// Regiones donde se corre cada check (códigos de locationHint de
// Durable Objects: oeste de Norteamérica, oeste de Europa y
// Asia-Pacífico). El check se corre en las 3 en paralelo y el estado
// del monitor se decide por mayoría: un blip de red en una sola región
// ya no abre un incidente.
export const REGIONS: DurableObjectLocationHint[] = ["wnam", "weur", "apac"];

// Consumer de la cola: un mensaje = un check (o una alerta).
export async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      if (body.type === "check") {
        await runMonitorCheck(env, body.monitorId);
      } else if (body.type === "alert") {
        const monitor = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?")
          .bind(body.monitorId)
          .first<Monitor>();
        if (monitor) await sendAlert(env, monitor, body.cause);
      }
    } catch (e) {
      // Un mensaje fallido no debe tumbar el resto del batch.
      console.error("queue message failed", body, e);
    }
  }
}

async function runMonitorCheck(env: Env, monitorId: string): Promise<void> {
  const monitor = await env.DB.prepare("SELECT * FROM monitors WHERE id = ?")
    .bind(monitorId)
    .first<Monitor>();
  if (!monitor) return;

  // Fan-out a las 3 regiones en paralelo + TLS una sola vez (el cert
  // no depende de la región, sería redundante medirlo 3 veces).
  const [tlsDaysLeft, settled] = await Promise.all([
    maybeCheckTls(env, monitor),
    Promise.allSettled(REGIONS.map((region) => probeRegion(env, monitor, region))),
  ]);
  const results = settled
    .filter((r): r is PromiseFulfilledResult<CheckResult> => r.status === "fulfilled")
    .map((r) => r.value);
  // Si ninguna región respondió, no hay dato: no se marca ni up ni down.
  if (!results.length) return;

  // Una fila por región (la columna region por fin significa algo) +
  // métricas por región (blob3 = región).
  await Promise.all(
    results.map(async (result) => {
      result.tlsDaysLeft = tlsDaysLeft;
      await env.DB.prepare(
        `INSERT INTO checks
           (monitor_id, ts, region, ok, status_code, ttfb_ms, total_ms, error, dns_ok, tls_days_left)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          result.monitorId,
          result.ts,
          result.region,
          result.ok ? 1 : 0,
          result.statusCode,
          result.ttfbMs,
          result.totalMs,
          result.error,
          result.dnsOk ? 1 : 0,
          result.tlsDaysLeft,
        )
        .run();
      env.METRICS.writeDataPoint({
        blobs: [monitor.id, result.ok ? "up" : "down", result.region],
        doubles: [result.ttfbMs ?? 0, result.totalMs ?? 0],
        indexes: [monitor.id],
      });
    }),
  );

  // Consenso por mayoría para el DO (anti-falsos-positivos): el DO
  // decide si esto es una caída real con el resultado agregado.
  const consensus = buildConsensus(monitor, results, tlsDaysLeft);
  const id = env.MONITOR.idFromName(monitor.id);
  const stub = env.MONITOR.get(id);
  await stub.fetch("http://do/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(consensus),
  });
}

// Llama al RegionalProber de una región (la instancia vive ahí gracias
// a locationHint) y devuelve su CheckResult.
async function probeRegion(
  env: Env,
  monitor: Monitor,
  region: DurableObjectLocationHint,
): Promise<CheckResult> {
  const id = env.REGIONAL_PROBER.idFromName(region);
  const stub = env.REGIONAL_PROBER.get(id, { locationHint: region });
  const res = await stub.fetch("http://prober/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ monitor, region }),
  });
  if (!res.ok) throw new Error(`region ${region} failed: ${res.status}`);
  return (await res.json()) as CheckResult;
}

// Agrega los resultados regionales en uno solo por mayoría: ok si más
// de la mitad de las regiones ven el sitio bien; TTFB/total en mediana.
function buildConsensus(
  monitor: Monitor,
  results: CheckResult[],
  tlsDaysLeft: number | null,
): CheckResult {
  const okCount = results.filter((r) => r.ok).length;
  const ok = okCount > results.length / 2;
  const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : null);
  const ttfbs = results
    .map((r) => r.ttfbMs)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const totals = results
    .map((r) => r.totalMs)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  const firstOk = results.find((r) => r.ok);
  const firstFail = results.find((r) => !r.ok);
  return {
    monitorId: monitor.id,
    ts: Date.now(),
    region: "multi",
    ok,
    statusCode: ok ? (firstOk?.statusCode ?? null) : (firstFail?.statusCode ?? null),
    ttfbMs: median(ttfbs),
    totalMs: median(totals),
    error: ok ? null : (firstFail?.error ?? "multi_region_fail"),
    dnsOk: results.filter((r) => r.dnsOk === true).length > results.length / 2,
    tlsDaysLeft,
  };
}

// Corre el check (HTTP + DNS en paralelo) desde la región que lo
// invoca. Lo usa el RegionalProber; el TLS se mide aparte, una sola
// vez por monitor (no depende de la región).
export async function runCheck(env: Env, monitor: Monitor, region: string): Promise<CheckResult> {
  const hostname = new URL(monitor.url).hostname;
  const [http, dns] = await Promise.all([checkHttp(monitor), checkDns(hostname)]);
  return {
    monitorId: monitor.id,
    ts: Date.now(),
    region,
    ok: http.ok,
    statusCode: http.statusCode,
    ttfbMs: http.ttfbMs,
    totalMs: http.totalMs,
    error: http.ok ? null : (http.error ?? `dns_${dns.ok ? "ok" : "fail"}`),
    dnsOk: dns.ok,
    tlsDaysLeft: null,
  };
}

async function checkHttp(m: Monitor): Promise<{
  ok: boolean;
  statusCode: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  error: string | null;
}> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(m.url, {
      signal: ctrl.signal,
      redirect: "follow",
      cf: { cacheTtl: 0 }, // nunca cachear un check
    });
    const ttfb = Date.now() - t0;
    const body = await res.text();
    const ok = res.status === m.expected_status && (!m.keyword || body.includes(m.keyword));
    return {
      ok,
      statusCode: res.status,
      ttfbMs: ttfb,
      totalMs: Date.now() - t0,
      error: ok ? null : `unexpected_status_${res.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      statusCode: null,
      ttfbMs: null,
      totalMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(to);
  }
}

// DNS por DNS-over-HTTPS contra 1.1.1.1 (registro A).
async function checkDns(hostname: string): Promise<{ ok: boolean; answers: string[] }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: "application/dns-json" }, signal: ctrl.signal },
    );
    const j = (await r.json()) as { Status: number; Answer?: { data: string }[] };
    const answers = (j.Answer ?? []).map((a) => a.data);
    return { ok: j.Status === 0 && answers.length > 0, answers };
  } catch {
    return { ok: false, answers: [] };
  } finally {
    clearTimeout(to);
  }
}

// La expiración TLS se consulta como mucho una vez al día por monitor
// (crt.sh no es para pegarle cada minuto).
async function maybeCheckTls(env: Env, m: Monitor): Promise<number | null> {
  if (!m.url.startsWith("https://")) return null;
  const now = Date.now();
  const row = await env.DB.prepare("SELECT not_after, checked_at FROM certs WHERE monitor_id = ?")
    .bind(m.id)
    .first<{ not_after: number | null; checked_at: number }>();
  if (row && now - row.checked_at < 24 * 3600_000) {
    return row.not_after ? Math.round((row.not_after - now) / 86_400_000) : null;
  }
  const hostname = new URL(m.url).hostname;
  const info = await checkCertExpiry(hostname);
  if (!info) return null;
  await env.DB.prepare(
    `INSERT INTO certs (monitor_id, issuer, not_after, checked_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(monitor_id) DO UPDATE SET
       issuer = excluded.issuer,
       not_after = excluded.not_after,
       checked_at = excluded.checked_at`,
  )
    .bind(m.id, info.issuer, info.expiresAt, now)
    .run();
  return info.daysLeft;
}
