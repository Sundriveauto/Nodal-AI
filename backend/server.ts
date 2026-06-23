/**
 * backend/server.ts
 * Health check HTTP server for container orchestration (Kubernetes, Docker Swarm).
 * Exposes GET /health — returns 200 when all dependencies are up, 503 otherwise.
 */

import * as http from "http";
import { horizonServer } from "./rpc_client";
import { db } from "./db/client";

const HEALTH_PATH = "/health";

type ComponentStatus = "up" | "down";

interface HealthResponse {
  status: "ok" | "degraded";
  components: {
    rpc: ComponentStatus;
    database: ComponentStatus;
  };
}

async function checkRpc(): Promise<ComponentStatus> {
  try {
    await horizonServer.fetchBaseFee();
    return "up";
  } catch {
    return "down";
  }
}

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    const ok = await db.healthCheck();
    return ok ? "up" : "down";
  } catch {
    return "down";
  }
}

export function createHealthServer(port = 3001): http.Server {
  const server = http.createServer(async (req, res) => {
    // Exclude health endpoint from standard request logging to prevent log spam
    if (req.method !== "GET" || req.url !== HEALTH_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }

    const [rpc, database] = await Promise.all([checkRpc(), checkDatabase()]);

    const allUp = rpc === "up" && database === "up";
    const statusCode = allUp ? 200 : 503;
    const body: HealthResponse = {
      status: allUp ? "ok" : "degraded",
      components: { rpc, database },
    };

    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });

  server.listen(port, () => {
    console.log(`[HealthServer] Listening on :${port}${HEALTH_PATH}`);
  });

  return server;
}
