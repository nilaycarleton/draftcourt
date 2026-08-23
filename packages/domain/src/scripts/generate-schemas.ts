import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  leagueScoringRuleSchema,
  projectedLineSchema,
  recommendationSchema,
  scoreComponentSchema,
} from "../contracts";

/**
 * Generates JSON Schema files from the Zod contracts so the Python analytics
 * service (Pydantic) can be tested against the exact same shape as the
 * TypeScript app layer. Run via `pnpm contracts:generate`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../../../../data/schemas");

const targets: Record<string, z.ZodType> = {
  "league-scoring-rule": leagueScoringRuleSchema,
  "projected-line": projectedLineSchema,
  "score-component": scoreComponentSchema,
  recommendation: recommendationSchema,
};

mkdirSync(outDir, { recursive: true });

for (const [name, schema] of Object.entries(targets)) {
  const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
  const outPath = resolve(outDir, `${name}.schema.json`);
  writeFileSync(outPath, JSON.stringify(jsonSchema, null, 2) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log(`wrote ${outPath}`);
}
