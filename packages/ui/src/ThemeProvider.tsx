"use client";

import { Theme, useTheme } from "@astryxdesign/core/theme";
// Prebuilt theme artifact (not the runtime-style-injection variant) — see
// docs/adr/0003-ui-and-motion.md and styles.css, which imports the matching
// static theme.css.
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { useCallback, useSyncExternalStore, type ReactNode } from "react";

export type DraftCourtTheme = "light" | "dark";
export type DraftCourtThemePreference = DraftCourtTheme | "system";

const STORAGE_KEY = "draftcourt-theme-preference";

/**
 * Minimal pub/sub store over localStorage, read through
 * `useSyncExternalStore` rather than an effect + setState — the latter
 * causes an extra render pass and risks a hydration mismatch for exactly
 * this "read browser-only state on mount" case (see
 * https://react.dev/reference/react/useSyncExternalStore).
 */
const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readStoredPreference(): DraftCourtThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function getServerSnapshot(): DraftCourtThemePreference {
  // Matches the `data-theme="dark"` default set on <html> in the root layout.
  return "dark";
}

function writePreference(next: DraftCourtThemePreference): void {
  if (next === "system") {
    window.localStorage.removeItem(STORAGE_KEY);
  } else {
    window.localStorage.setItem(STORAGE_KEY, next);
  }
  emitChange();
}

/**
 * Root theme provider for DraftCourt. Wraps Astryx's own `<Theme>` (which
 * owns applying `data-theme`/`color-scheme` to `<html>` for the root
 * instance — see BaseProps docs) with DraftCourt's persisted user
 * preference. `packages/ui/src/tokens.css` layers DraftCourt's semantic
 * tokens on the same `[data-theme]` attribute Astryx sets, so both systems
 * stay in sync without duplicated state.
 *
 * Mapping DraftCourt's full palette into Astryx's own `defineTheme()` token
 * schema is deferred past Phase 0 — see docs/adr/0003-ui-and-motion.md.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const preference = useSyncExternalStore(subscribe, readStoredPreference, getServerSnapshot);

  return (
    <Theme theme={neutralTheme} mode={preference}>
      {children}
    </Theme>
  );
}

/** Resolved theme (never "system") plus the user's raw preference and setter. */
export function useDraftCourtTheme(): {
  resolvedTheme: DraftCourtTheme;
  preference: DraftCourtThemePreference;
  setPreference: (preference: DraftCourtThemePreference) => void;
} {
  const astryxTheme = useTheme();
  const preference = useSyncExternalStore(subscribe, readStoredPreference, getServerSnapshot);
  const setPreference = useCallback((next: DraftCourtThemePreference) => {
    writePreference(next);
  }, []);

  return {
    resolvedTheme: astryxTheme.mode,
    preference,
    setPreference,
  };
}
