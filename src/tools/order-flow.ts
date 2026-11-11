/**
 * Order lifecycle helpers for `place_futures_order`.
 *
 * Pure status / id / risk helpers live here so they are unit-testable; the
 * network-facing wait loop takes the client as a parameter.
 */

import { getClient } from "../binance/client";
import { config } from "../config";

export type FuturesClient = ReturnType<typeof getClient>;

/** Order statuses that will never transition further. */
const TERMINAL_STATUSES = new Set([
  "FILLED",
  "CANCELED",
  "REJECTED",
  "EXPIRED",
  "EXPIRED_IN_MATCH",
]);

/** Order statuses that hold open quantity and can still fill. */
export const ACTIVE_STATUSES = new Set(["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]);

export function normalizeOrderStatus(order: Record<string, unknown> | null): string {
  if (!order) return "UNKNOWN";
  const status = order.status;
  return status === undefined || status === null
    ? "UNKNOWN"
    : String(status).toUpperCase();
}

export function isTerminalOrderStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isFilledStatus(status: string): boolean {
  return status === "FILLED" || status === "PARTIALLY_FILLED";
}

/**
 * Binance futures `newClientOrderId` only accepts [A-Za-z0-9._-] (max 36).
 * We trim to 32 and strip everything else so a caller-supplied idempotency
 * key is never rejected by the exchange filter.
 */
export function sanitizeClientOrderId(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const cleaned = String(raw).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Final stop risk in USDT: qty x entry x stop-distance, plus both taker fees. */
export function computeFinalRiskUsd(
  qty: number,
  entryPrice: number,
  stopPrice: number,
): number {
  if (qty <= 0 || entryPrice <= 0) return 0;
  const stopDistance = Math.abs(entryPrice - stopPrice) / entryPrice;
  return qty * entryPrice * stopDistance * (1 + 2 * 0.0005);
}

/**
 * GET /fapi/v1/order lookup. Returns null when the order does not exist
 * (-2013) or the lookup itself fails — callers must treat `null` as "state
 * unknown", never as proof that nothing was placed.
 */
export async function lookupFuturesOrder(
  client: FuturesClient,
  symbol: string,
  params: { orderId?: number; origClientOrderId?: string },
): Promise<Record<string, unknown> | null> {
  try {
    return (await client.getOrder(symbol, params)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Poll the order until it reaches a terminal status or the deadline passes. */
export async function waitForTerminalStatus(
  client: FuturesClient,
  symbol: string,
  orderId: number,
  deadlineMs: number,
  pollMs = config.entryFillPollMs,
): Promise<Record<string, unknown> | null> {
  let order: Record<string, unknown> | null = null;
  while (Date.now() < deadlineMs) {
    await sleep(pollMs);
    try {
      order = (await client.getOrder(symbol, { orderId })) as Record<string, unknown>;
    } catch {
      continue; // transient lookup failure — keep polling until deadline
    }
    if (isTerminalOrderStatus(normalizeOrderStatus(order))) return order;
  }
  return order; // deadline hit; last known state (possibly still active)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
