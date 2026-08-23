import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "@/lib/server/circuit-breaker";

describe("CircuitBreaker", () => {
  it("returns the underlying result on success and stays closed", async () => {
    const breaker = new CircuitBreaker(3, 30_000);
    const result = await breaker.exec(
      () => Promise.resolve("ok"),
      () => "fallback",
    );
    expect(result).toBe("ok");
    expect(breaker.isOpen).toBe(false);
  });

  it("falls back on a single failure without opening", async () => {
    const breaker = new CircuitBreaker(3, 30_000);
    const result = await breaker.exec(
      () => Promise.reject(new Error("boom")),
      () => "fallback",
    );
    expect(result).toBe("fallback");
    expect(breaker.isOpen).toBe(false);
  });

  it("opens after reaching the failure threshold, then short-circuits", async () => {
    const breaker = new CircuitBreaker(2, 30_000);
    const failing = () => Promise.reject(new Error("boom"));

    await breaker.exec(failing, () => "fallback");
    expect(breaker.isOpen).toBe(false);
    await breaker.exec(failing, () => "fallback");
    expect(breaker.isOpen).toBe(true);

    const spy = vi.fn().mockResolvedValue("should not run");
    const result = await breaker.exec(spy, () => "fallback");
    expect(result).toBe("fallback");
    expect(spy).not.toHaveBeenCalled();
  });

  it("closes again after resetAfterMs once a trial call succeeds", async () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(1, 1000);
      await breaker.exec(
        () => Promise.reject(new Error("boom")),
        () => "fallback",
      );
      expect(breaker.isOpen).toBe(true);

      vi.advanceTimersByTime(1500);
      expect(breaker.isOpen).toBe(false);

      const result = await breaker.exec(
        () => Promise.resolve("recovered"),
        () => "fallback",
      );
      expect(result).toBe("recovered");
      expect(breaker.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the failure count after a success", async () => {
    const breaker = new CircuitBreaker(2, 30_000);
    await breaker.exec(
      () => Promise.reject(new Error("boom")),
      () => "fallback",
    );
    await breaker.exec(
      () => Promise.resolve("ok"),
      () => "fallback",
    );
    // A second consecutive failure shouldn't open it (count was reset).
    const result = await breaker.exec(
      () => Promise.reject(new Error("boom")),
      () => "fallback",
    );
    expect(result).toBe("fallback");
    expect(breaker.isOpen).toBe(false);
  });
});
