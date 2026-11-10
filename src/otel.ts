import type { CheckResult, Env } from "./types";

// Métricas a Grafana Cloud por OTLP/HTTP (JSON). El Worker manda cada
// resultado regional como un gauge: TTFB, tiempo total y up (1/0).
// Son poquísimas series (2 monitores x 3 regiones x 3 métricas),
// muy dentro del free tier de Grafana Cloud (10k series).
//
// Secrets (opcionales; sin ellos no se manda nada):
//   GRAFANA_OTLP_ENDPOINT: base del gateway, ej.
//     https://otlp-gateway-prod-us-central-0.grafana.net/otlp
//   GRAFANA_OTLP_USER: instance ID del stack (usuario Basic Auth)
//   GRAFANA_OTLP_KEY: Cloud Access Policy token con metrics:write
// El endpoint acepta JSON (application/json) en /v1/metrics.
// El envío es best-effort: si Grafana falla, el check sigue igual.

export async function pushMetrics(env: Env, results: CheckResult[]): Promise<void> {
  const base = env.GRAFANA_OTLP_ENDPOINT;
  const user = env.GRAFANA_OTLP_USER;
  const key = env.GRAFANA_OTLP_KEY;
  if (!base || !user || !key) return;
  const url = base.endsWith("/v1/metrics") ? base : base.replace(/\/$/, "") + "/v1/metrics";

  const nowNs = String(Date.now()) + "000000"; // ms -> ns (string, evita overflow)
  const attrs = (r: CheckResult) => [
    { key: "monitor", value: { stringValue: r.monitorId } },
    { key: "region", value: { stringValue: r.region } },
  ];
  const gauge = (name: string, unit: string, points: object[]) => ({
    name,
    unit,
    gauge: { dataPoints: points },
  });
  const payload = {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: "vigia" } }],
        },
        scopeMetrics: [
          {
            scope: { name: "vigia-prober" },
            metrics: [
              gauge("vigia_check_ttfb_ms", "ms", results.map((r) => ({
                attributes: attrs(r),
                timeUnixNano: nowNs,
                asDouble: r.ttfbMs ?? 0,
              }))),
              gauge("vigia_check_total_ms", "ms", results.map((r) => ({
                attributes: attrs(r),
                timeUnixNano: nowNs,
                asDouble: r.totalMs ?? 0,
              }))),
              gauge("vigia_check_up", "1", results.map((r) => ({
                attributes: attrs(r),
                timeUnixNano: nowNs,
                asInt: r.ok ? "1" : "0",
              }))),
            ],
          },
        ],
      },
    ],
  };

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: "Basic " + btoa(`${user}:${key}`),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.error("otlp push failed", res.status, (await res.text()).slice(0, 200));
  } catch (e) {
    console.error("otlp push error", e);
  } finally {
    clearTimeout(to);
  }
}
