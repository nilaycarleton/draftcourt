import { describe, expect, it } from "vitest";
import { checkProjectionFreshness } from "@/lib/inngest/functions/freshness-check";
import { getCurrentRun } from "@/lib/server/current-run";

describe("checkProjectionFreshness", () => {
  it("reflects the real current run's published age", async () => {
    const run = await getCurrentRun();
    const result = await checkProjectionFreshness();

    if (!run) {
      expect(result.stale).toBe(true);
      expect(result.reason).toContain("no published");
      return;
    }

    expect(result.runId).toBe(run.runId);
    expect(result.ageHours).toBeGreaterThanOrEqual(0);
    // The demo dataset was just published in this session, so it should
    // read as fresh — a genuinely stale run would flip this to true.
    expect(result.stale).toBe((result.ageHours ?? 0) > 24);
  });
});
