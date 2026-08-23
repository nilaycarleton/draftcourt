import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/sentry-redact";

Sentry.init({
  dsn: process.env.SENTRY_DSN || undefined,
  environment: process.env.SENTRY_ENVIRONMENT ?? "development",
  tracesSampleRate: 0,
  beforeSend: scrubSentryEvent,
});
