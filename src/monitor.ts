import type { CheckResult, Env } from "./types";

// Durable Object: un objeto por monitor. Guarda el estado entre checks
// y decide si una caída es real — nunca por un solo fallo aislado.
// Regla v1: 2 fallos seguidos = incidente abierto.
export class Monitor {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/check") {
      const result = (await request.json()) as CheckResult;
      await this.onCheck(result);
      return new Response("ok");
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const fails = (await this.state.storage.get<number>("fails")) ?? 0;
      const incidentOpen = (await this.state.storage.get<boolean>("incidentOpen")) ?? false;
      return Response.json({ fails, incidentOpen });
    }
    return new Response("not found", { status: 404 });
  }

  private async onCheck(result: CheckResult): Promise<void> {
    let fails = (await this.state.storage.get<number>("fails")) ?? 0;
    const incidentOpen = (await this.state.storage.get<boolean>("incidentOpen")) ?? false;

    if (result.ok) {
      await this.state.storage.put("fails", 0);
      if (incidentOpen) {
        await this.env.DB.prepare(
          "UPDATE incidents SET ended_at = ? WHERE monitor_id = ? AND ended_at IS NULL",
        )
          .bind(result.ts, result.monitorId)
          .run();
        await this.state.storage.put("incidentOpen", false);
        await this.env.STATUS.put(`monitor:${result.monitorId}`, "up");
      }
      return;
    }

    fails += 1;
    await this.state.storage.put("fails", fails);
    await this.env.DB.prepare(
      "UPDATE incidents SET checks_failed = checks_failed + 1 WHERE monitor_id = ? AND ended_at IS NULL",
    )
      .bind(result.monitorId)
      .run();

    if (fails >= 2 && !incidentOpen) {
      const cause = result.error ?? `http_${result.statusCode ?? "unknown"}`;
      await this.env.DB.prepare(
        "INSERT INTO incidents (monitor_id, started_at, cause, checks_failed) VALUES (?, ?, ?, ?)",
      )
        .bind(result.monitorId, result.ts, cause, fails)
        .run();
      await this.state.storage.put("incidentOpen", true);
      await this.env.STATUS.put(`monitor:${result.monitorId}`, "down");
      await this.env.CHECK_QUEUE.send({ type: "alert", monitorId: result.monitorId, cause });
    }
  }
}
