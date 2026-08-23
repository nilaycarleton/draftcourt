import { Inngest } from "inngest";
import { isInngestConfigured } from "@/lib/env";

/** Runs against the local Inngest Dev Server with no cloud account or keys
 * required (`npx inngest-cli@latest dev`, per its own docs) — `isDev` is
 * explicit rather than left to Inngest's own env-var autodetection so this
 * matches every other optional integration in this repo (see lib/env.ts):
 * unconfigured locally/CI, real keys picked up automatically in a real
 * deployment. Without this, unauthenticated requests to `/api/inngest`
 * 500 instead of degrading — verified directly against the running dev
 * server. */
export const inngest = new Inngest({ id: "draftcourt", isDev: !isInngestConfigured });
