export interface Monitor {
  id: string;
  name: string;
  url: string;
  check_interval_s: number;
  keyword: string | null;
  expected_status: number;
  created_at: number;
  // Último check pedido (epoch ms). NULL = nunca: el monitor está vencido.
  last_checked_at: number | null;
}

export interface CheckResult {
  monitorId: string;
  ts: number;
  region: string;
  ok: boolean;
  statusCode: number | null;
  ttfbMs: number | null;
  totalMs: number | null;
  error: string | null;
  dnsOk: boolean | null;
  tlsDaysLeft: number | null;
}

export type QueueMessage =
  | { type: "check"; monitorId: string }
  | { type: "alert"; monitorId: string; cause: string };

export interface Env {
  DB: D1Database;
  STATUS: KVNamespace;
  CHECK_QUEUE: Queue<QueueMessage>;
  MONITOR: DurableObjectNamespace;
  REGIONAL_PROBER: DurableObjectNamespace;
  METRICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ADMIN_TOKEN?: string;
  // URL del heartbeat de Better Stack (secret). Sin ella, no se pinea.
  HEARTBEAT_URL?: string;
  // Grafana Cloud OTLP (secrets, opcionales). Sin ellos no se manda nada.
  GRAFANA_OTLP_ENDPOINT?: string;
  GRAFANA_OTLP_USER?: string;
  GRAFANA_OTLP_KEY?: string;
}
