import type { Env, QueueMessage } from "./types";
import { handleFetch } from "./api";
import { handleQueue } from "./prober";

export { Monitor } from "./monitor";

// Entry point del Worker: un solo módulo con los tres handlers.
// - fetch: API pública + página de estado.
// - scheduled (cron, cada minuto): encola un check por monitor.
// - queue: los probers consumen los checks en paralelo por el mundo.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const now = Date.now();
    const { results } = await env.DB.prepare(
      "SELECT id, check_interval_s, last_checked_at FROM monitors",
    ).all<{
      id: string;
      check_interval_s: number;
      last_checked_at: number | null;
    }>();
    // Solo se revisan los monitores vencidos: nunca revisados, o con el
    // último check más viejo que su intervalo. Antes se revisaban todos
    // cada minuto e ignoraban check_interval_s.
    const due = (results ?? []).filter(
      (m) => m.last_checked_at == null || now - m.last_checked_at >= m.check_interval_s * 1000,
    );
    if (!due.length) return;
    // Encolar en paralelo (antes un await por monitor, en serie).
    const sent = await Promise.allSettled(
      due.map((m) => env.CHECK_QUEUE.send({ type: "check", monitorId: m.id })),
    );
    const ok = due.filter((_, i) => sent[i].status === "fulfilled");
    if (!ok.length) return;
    // Marcar como revisados al encolar: el intervalo se mide desde que
    // se pide el check. Solo los que sí se encolaron.
    await env.DB.prepare(
      `UPDATE monitors SET last_checked_at = ? WHERE id IN (${ok.map(() => "?").join(",")})`,
    )
      .bind(now, ...ok.map((m) => m.id))
      .run();
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};
