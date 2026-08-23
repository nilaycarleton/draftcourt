import { serve } from "inngest/next";
import { inngest } from "@/lib/inngest/client";
import { freshnessCheckFunction } from "@/lib/inngest/functions/freshness-check";
import {
  nightlyRefreshFunction,
  onDemandPublishFunction,
} from "@/lib/inngest/functions/nightly-refresh";

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [freshnessCheckFunction, nightlyRefreshFunction, onDemandPublishFunction],
});
