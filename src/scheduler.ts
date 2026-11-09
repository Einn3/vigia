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
    const { results } = await env.DB.prepare("SELECT id FROM monitors").all<{ id: string }>();
    for (const row of results ?? []) {
      await env.CHECK_QUEUE.send({ type: "check", monitorId: row.id });
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await handleQueue(batch, env);
  },
};
