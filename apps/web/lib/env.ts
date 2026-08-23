import { z } from "zod";

/**
 * Validates process.env at startup per BUILD_SPEC.md section 15. Required
 * variables fail fast; optional integrations (Clerk, Sentry, Inngest,
 * Upstash, OpenAI) are allowed to be unset so local development and Phase 0
 * CI can run without any real secrets — see .env.example.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.url().default("http://localhost:3100"),

  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1),

  CLERK_SECRET_KEY: z.string().optional().default(""),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional().default(""),
  CLERK_WEBHOOK_SIGNING_SECRET: z.string().optional().default(""),

  UPSTASH_REDIS_REST_URL: z.string().optional().default(""),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional().default(""),
  REDIS_URL: z.string().optional().default(""),

  ANALYTICS_BASE_URL: z.string().min(1),
  ANALYTICS_SERVICE_SECRET: z.string().min(1),

  INNGEST_EVENT_KEY: z.string().optional().default(""),
  INNGEST_SIGNING_KEY: z.string().optional().default(""),

  SENTRY_DSN: z.string().optional().default(""),
  SENTRY_AUTH_TOKEN: z.string().optional().default(""),
  SENTRY_ENVIRONMENT: z.string().optional().default("development"),

  OPENAI_API_KEY: z.string().optional().default(""),
  AI_ASSISTANT_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  PUBLIC_DEMO_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type Env = z.infer<typeof envSchema>;

/** Throws with a readable message if a required variable is missing/invalid. */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const env = parseEnv();

/** True when Clerk keys are configured; auth routes stay disabled otherwise. */
export const isClerkConfigured = Boolean(
  env.CLERK_SECRET_KEY && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

/** True when a Sentry DSN is configured; the SDK no-ops otherwise. */
export const isSentryConfigured = Boolean(env.SENTRY_DSN);

/** True when real Inngest keys are configured (a real deployment target);
 * false locally/CI, where the client runs against the local Inngest Dev
 * Server instead (`isDev: true` — see lib/inngest/client.ts). */
export const isInngestConfigured = Boolean(env.INNGEST_EVENT_KEY && env.INNGEST_SIGNING_KEY);
