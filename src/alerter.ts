import type { Env, Monitor } from "./types";

// Alertas: webhook genérico (Discord, Slack, endpoint propio) y/o
// Telegram. Si no hay nada configurado, no hace nada (sin errores).
export async function sendAlert(env: Env, monitor: Monitor, cause: string): Promise<void> {
  const text = `🚨 ${monitor.name} está caído (${monitor.url}) — causa: ${cause}`;
  const jobs: Promise<unknown>[] = [];

  if (env.WEBHOOK_URL) {
    jobs.push(
      fetch(env.WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          monitor: monitor.id,
          name: monitor.name,
          url: monitor.url,
          cause,
          ts: Date.now(),
        }),
      }).catch(() => undefined),
    );
  }

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      }).catch(() => undefined),
    );
  }

  await Promise.allSettled(jobs);
}
