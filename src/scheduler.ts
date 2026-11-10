import type { Env, QueueMessage } from "./types";
import { handleFetch } from "./api";
import { handleQueue } from "./prober";

export { Monitor } from "./monitor";
export { RegionalProber } from "./regionalProber";

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
    if (due.length) {
      // Encolar en paralelo (antes un await por monitor, en serie).
      const sent = await Promise.allSettled(
        due.map((m) => env.CHECK_QUEUE.send({ type: "check", monitorId: m.id })),
      );
      const ok = due.filter((_, i) => sent[i].status === "fulfilled");
      if (ok.length) {
        // Marcar como revisados al encolar: el intervalo se mide desde que
        // se pide el check. Solo los que sí se encolaron.
        await env.DB.prepare(
          `UPDATE monitors SET last_checked_at = ? WHERE id IN (${ok.map(() => "?").join(",")})`,
        )
          .bind(now, ...ok.map((m) => m.id))
          .run();
      }
    }
    // Heartbeat para vigilar a vigia: si este ping deja de llegar,
    // Better Stack avisa (el cron murió o el Worker se rompió). Se
    // pinea aunque no haya nada vencido: lo que importa es que el
    // scheduler corrió. Sin HEARTBEAT_URL no hace nada.
    await pingHeartbeat(env);
    // Poda: borrar checks de más de 30 días. Corre como mucho una vez
    // al día (la última poda se guarda en KV); sin ella la tabla crece
    // para siempre (~2.880 filas/día con 2 monitores).
    await pruneOldChecks(env);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};

// Un GET al heartbeat de Better Stack. Si no llega el ping en el
// periodo configurado, Better Stack avisa: el cron murió o el Worker
// se rompió. Un fallo al pinear nunca debe tumbar el scheduler.
async function pingHeartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  try {
    await fetch(env.HEARTBEAT_URL, { signal: ctrl.signal });
  } catch {
    // Silencioso a propósito: el heartbeat es observabilidad, no el check.
  } finally {
    clearTimeout(to);
  }
}

// Borra los checks de más de 30 días. Corre como mucho una vez al día:
// la última poda se guarda en KV (`prune:last`). Un fallo en la poda
// nunca debe tumbar el scheduler.
async function pruneOldChecks(env: Env): Promise<void> {
  try {
    const last = await env.STATUS.get("prune:last");
    const now = Date.now();
    if (last && now - Number(last) < 24 * 3600_000) return;
    const cutoff = now - 30 * 24 * 3600_000;
    await env.DB.prepare("DELETE FROM checks WHERE ts < ?").bind(cutoff).run();
    await env.STATUS.put("prune:last", String(now));
  } catch {
    // Silencioso a propósito: la poda es mantenimiento, no el check.
  }
}
