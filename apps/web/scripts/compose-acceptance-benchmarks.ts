/**
 * Composes docs/benchmarks/phase3-acceptance-latest.json from the seven
 * per-suite benchmark JSONs (BUILD_SPEC.md §19, M9).
 *
 * No numbers are invented here: every measurement is read from its source
 * file, threshold verdicts are computed mechanically, and gaps are recorded
 * as limitations. Re-run the bench:* scripts first for current-commit
 * figures, then run: pnpm --filter web run bench:acceptance-compose
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { join } from "node:path";
import { loadRootEnv } from "@draftcourt/db/src/load-root-env";

loadRootEnv();

const REPO_ROOT = join(process.cwd(), "..", "..");
const DIR = join(REPO_ROOT, "docs", "benchmarks");

function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as Record<string, unknown>;
}

function getPath(obj: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | null)?.[key], obj);
}

interface Verdict {
  suite: string;
  metric: string;
  p95: number | null;
  targetUnderMs: number | null;
  pass: boolean | null;
}

// [suite file, label, dotted p95 path, dotted target path]
const CHECKS: [string, string, string, string][] = [
  [
    "team-matrix-latest.json",
    "team-matrix 8-team warm rec",
    "teams.8.warmRecommendationMs.p95",
    "thresholds.warmRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 8-team cold rec",
    "teams.8.coldRecommendationMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 8-team pick",
    "teams.8.pickMutationMs.p95",
    "thresholds.pickMutationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 10-team warm rec",
    "teams.10.warmRecommendationMs.p95",
    "thresholds.warmRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 10-team cold rec",
    "teams.10.coldRecommendationMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 10-team pick",
    "teams.10.pickMutationMs.p95",
    "thresholds.pickMutationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 12-team warm rec",
    "teams.12.warmRecommendationMs.p95",
    "thresholds.warmRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 12-team cold rec",
    "teams.12.coldRecommendationMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 12-team pick",
    "teams.12.pickMutationMs.p95",
    "thresholds.pickMutationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 14-team warm rec",
    "teams.14.warmRecommendationMs.p95",
    "thresholds.warmRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 14-team cold rec",
    "teams.14.coldRecommendationMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 14-team pick",
    "teams.14.pickMutationMs.p95",
    "thresholds.pickMutationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 16-team warm rec",
    "teams.16.warmRecommendationMs.p95",
    "thresholds.warmRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 16-team cold rec",
    "teams.16.coldRecommendationMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "team-matrix 16-team pick",
    "teams.16.pickMutationMs.p95",
    "thresholds.pickMutationP95UnderMs",
  ],
  [
    "team-matrix-latest.json",
    "synthetic-600 recommend",
    "synthetic600.recommendMs.p95",
    "thresholds.coldRecommendationP95UnderMs",
  ],
  ["recommendations-latest.json", "recommendations warm", "warm.p95", "targets.warmP95UnderMs"],
  ["recommendations-latest.json", "recommendations cold", "cold.p95", "targets.coldP95UnderMs"],
  // preferences-latest.json reports per-scenario timings (no top-level
  // aggregate), so the gate evaluates the worst scenario p95 — conservative
  // and mechanical, never invented.
  [
    "preferences-latest.json",
    "preferences warm (worst scenario)",
    "scenariosMax.warm.p95",
    "targets.warmP95UnderMs",
  ],
  [
    "preferences-latest.json",
    "preferences cold (worst scenario)",
    "scenariosMax.cold.p95",
    "targets.coldP95UnderMs",
  ],
];

function main(): void {
  const commit = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();
  const suites: Record<string, unknown> = {};
  for (const name of [
    "team-matrix-latest.json",
    "recommendations-latest.json",
    "preferences-latest.json",
    "cpu-mock-latest.json",
    "demo-drafts-latest.json",
    "history-analysis-latest.json",
    "replay-sharing-latest.json",
  ]) {
    suites[name.replace("-latest.json", "")] = read(name);
  }

  const verdicts: Verdict[] = CHECKS.map(([file, metric, p95Path, targetPath]) => {
    const suite = read(file);
    let p95: unknown = getPath(suite, p95Path);
    if (typeof p95 !== "number" && p95Path.startsWith("scenariosMax.")) {
      const key = p95Path.includes(".warm.") ? "warm" : "cold";
      const scenarios = (suite as { scenarios?: unknown }).scenarios;
      const values = Array.isArray(scenarios)
        ? scenarios
            .map((scenario) => {
              const entry = (scenario as Record<string, unknown> | null)?.[key] as {
                p95?: unknown;
              } | null;
              return entry?.p95;
            })
            .filter((value): value is number => typeof value === "number")
        : [];
      p95 = values.length > 0 ? Math.max(...values) : null;
    }
    const target = getPath(suite, targetPath);
    const p95Num = typeof p95 === "number" ? p95 : null;
    const targetNum = typeof target === "number" ? target : null;
    return {
      suite: file,
      metric,
      p95: p95Num,
      targetUnderMs: targetNum,
      pass: p95Num !== null && targetNum !== null ? p95Num < targetNum : null,
    };
  });

  const failed = verdicts.filter((v) => v.pass === false);
  const result = {
    date: new Date().toISOString(),
    machine: `${platform()}/${release()} ${cpus()[0]?.model ?? "unknown-cpu"}`,
    runtime: `node ${process.version}`,
    commit,
    suites,
    thresholdVerdicts: verdicts,
    overallLatencyGatesPass: failed.length === 0,
    failedGates: failed.map((v) => v.metric),
    limitations: [
      "Local-machine figures only — never cited as production SLO proof.",
      "Sample counts are small (n recorded per row); p99 ≈ max at these n.",
      `Node runtime here is ${process.version} (repo pins 24.18.0) — recorded honestly in runtime.`,
      "600-player figures are synthetic pure-engine scaling (labeled in source).",
      "Ingestion row is demo-scale throughput (see team-matrix ingestion stage).",
    ],
  };

  writeFileSync(join(DIR, "phase3-acceptance-latest.json"), JSON.stringify(result, null, 2) + "\n");
  // eslint-disable-next-line no-console -- benchmark output is the deliverable
  console.info(
    `wrote phase3-acceptance-latest.json: ${String(verdicts.length)} gates, ${String(failed.length)} failed`,
  );
}

main();
process.exit(0);
