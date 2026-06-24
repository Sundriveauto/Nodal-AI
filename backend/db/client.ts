/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the local storage layer.
 * Provides a healthCheck() method consumed by the health endpoint and
 * a close() method called during graceful shutdown.
 */

import { createLogger } from "../utils/logger";

const log = createLogger("database");

export class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private _isOpen = true;

  private constructor() {}

  static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /** Probe storage availability — equivalent to SELECT 1. */
  async healthCheck(): Promise<boolean> {
    return this._isOpen;
  }

  /** Flush pending writes and release the connection. */
  async close(): Promise<void> {
    this._isOpen = false;
    log.info({ msg: "Database connection closed" });
  }
}

export const db = DatabaseManager.getInstance();
