export interface Monitor {
  id: string;
  name: string;
  url: string;
  check_interval_s: number;
  keyword: string | null;
  expected_status: number;
  created_at: number;
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
  ARCHIVE: R2Bucket;
  METRICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  WEBHOOK_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ADMIN_TOKEN?: string;
}
