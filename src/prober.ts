import type { CheckResult, Env, Monitor, QueueMessage } from "./types";
import { checkCertExpiry } from "./tls";
import { sendAlert } from "./alerter";

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

  const http = await checkHttp(monitor);
  const hostname = new URL(monitor.url).hostname;
  const dns = await checkDns(hostname);
  const tlsDaysLeft = await maybeCheckTls(env, monitor);

  const result: CheckResult = {
    monitorId: monitor.id,
    ts: Date.now(),
    // v1: la cola no expone el colo; los checks corren repartidos por el
    // edge. La atribución por región es un ítem de la v2.
    region: "edge",
    ok: http.ok,
    statusCode: http.statusCode,
    ttfbMs: http.ttfbMs,
    totalMs: http.totalMs,
    error: http.ok ? null : (http.error ?? `dns_${dns.ok ? "ok" : "fail"}`),
    dnsOk: dns.ok,
    tlsDaysLeft,
  };

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
    blobs: [monitor.id, result.ok ? "up" : "down"],
    doubles: [result.ttfbMs ?? 0, result.totalMs ?? 0],
    indexes: [monitor.id],
  });

  // El Durable Object del monitor decide si esto es una caída real.
  const id = env.MONITOR.idFromName(monitor.id);
  const stub = env.MONITOR.get(id);
  await stub.fetch("http://do/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result),
  });
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
