import type { Env, Monitor } from "./types";
import { runCheck } from "./prober";

// Durable Object sin estado: corre un check desde su región. Se crea
// con locationHint (wnam / weur / apac) para que la instancia viva en
// esa región; el TTFB que mide es el de esa región.
export class RegionalProber {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const { monitor, region } = (await request.json()) as {
      monitor: Monitor;
      region: string;
    };
    const result = await runCheck(this.env, monitor, region);
    return Response.json(result);
  }
}
