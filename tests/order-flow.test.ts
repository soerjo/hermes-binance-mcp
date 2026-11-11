import { describe, expect, test } from "bun:test";

import {
  computeFinalRiskUsd,
  isFilledStatus,
  isTerminalOrderStatus,
  normalizeOrderStatus,
  sanitizeClientOrderId,
} from "../src/tools/order-flow";

describe("order status classification", () => {
  test("active statuses can still fill and are not terminal", () => {
    for (const status of ["NEW", "PARTIALLY_FILLED", "PENDING_NEW"]) {
      expect(isTerminalOrderStatus(status)).toBe(false);
    }
    expect(isFilledStatus("NEW")).toBe(false);
    expect(isFilledStatus("PARTIALLY_FILLED")).toBe(true);
    expect(isFilledStatus("FILLED")).toBe(true);
  });

  test("terminal statuses never transition further", () => {
    for (const status of ["FILLED", "CANCELED", "REJECTED", "EXPIRED", "EXPIRED_IN_MATCH"]) {
      expect(isTerminalOrderStatus(status)).toBe(true);
    }
  });

  test("normalizeOrderStatus uppercases and handles missing input", () => {
    expect(normalizeOrderStatus({ status: "new" })).toBe("NEW");
    expect(normalizeOrderStatus({})).toBe("UNKNOWN");
    expect(normalizeOrderStatus(null)).toBe("UNKNOWN");
  });
});

describe("client order id sanitization", () => {
  test("keeps allowed characters and truncates to 32", () => {
    expect(sanitizeClientOrderId("hermes-SUIUSDT-20261112-a")).toBe(
      "hermes-SUIUSDT-20261112-a",
    );
    expect(sanitizeClientOrderId("id with spaces & symbols!")!.length).toBeLessThanOrEqual(32);
    expect(sanitizeClientOrderId("x".repeat(40))).toHaveLength(32);
  });

  test("strips disallowed characters and drops empty results", () => {
    expect(sanitizeClientOrderId("a b/c") === "abc").toBe(true);
    expect(sanitizeClientOrderId("!!!")).toBeUndefined();
    expect(sanitizeClientOrderId(undefined)).toBeUndefined();
  });
});

describe("final risk computation", () => {
  test("risk = qty x entry x stop-distance x fee buffer", () => {
    // 1 contract @ 100, SL 98 → 2% distance, fee factor 1.001
    expect(computeFinalRiskUsd(1, 100, 98)).toBeCloseTo(2 * 1.001, 10);
  });

  test("short side uses absolute distance", () => {
    expect(computeFinalRiskUsd(2, 100, 101)).toBeCloseTo(2 * 1.001, 10);
  });

  test("non-positive qty or entry yields zero", () => {
    expect(computeFinalRiskUsd(0, 100, 98)).toBe(0);
    expect(computeFinalRiskUsd(1, 0, 98)).toBe(0);
  });
});
