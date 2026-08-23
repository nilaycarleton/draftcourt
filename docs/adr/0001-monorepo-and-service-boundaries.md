# ADR 0001: Monorepo layout and service boundaries

- Status: accepted
- Date: 2026-08-20
- Phase: 0 — foundation and contracts

## Context

BUILD_SPEC.md section 3 mandates a pnpm/Turborepo monorepo with a strict
boundary: browsers talk only to Next.js; the Python analytics service is
internal-only; the deterministic recommendation engine (later phases) lives
in a framework-free TypeScript package so it can run both server-side and,
as a preview, client-side.

## Decision

- **Package manager / task runner**: pnpm 11.22.0 (workspaces) + Turborepo
  2.10.11. pnpm's strict `node_modules` layout catches phantom dependencies
  early, and its new supply-chain policy features (`minimumReleaseAgeExclude`,
  `allowBuilds`) are used to block installing very-recently-published
  package versions by default — worth keeping as new packages are added.
- **Workspace layout** matches BUILD_SPEC.md section 3 exactly:
  `apps/web`, `services/analytics`, `packages/{db,domain,ui,config-eslint,config-typescript}`,
  `data`, `models`, `infra`, `docs`, `.github/workflows`.
- **Module resolution**: internal packages (`@draftcourt/domain`,
  `@draftcourt/ui`, `@draftcourt/db`) point `package.json` `main`/`types`/
  `exports` directly at TypeScript source (`./src/index.ts`), not a `dist/`
  build output. They are workspace-internal only (never published), and
  Next.js's `transpilePackages` + each package's own `tsc`/`vitest` handle
  the source directly — this removes an extra build step from every local
  iteration. A `build` script (`tsc -p tsconfig.build.json` or equivalent)
  still exists per package for CI verification that the package compiles
  standalone, and would be the switch-over point if a package is ever
  published externally.
  - Follow-on finding: relative imports **within** these packages must be
    extension-less (`./enums`, not `./enums.js`). Node/tsx/vitest resolve
    both forms fine via `moduleResolution: "Bundler"`, but Next.js's
    Turbopack build failed to resolve `.js`-suffixed imports against `.ts`
    source files across a workspace-package boundary. Extension-less is now
    the house style for internal package source.
- **Service boundary enforcement**: `packages/domain` has zero dependency on
  Next.js, React, or FastAPI — it is pure TypeScript + Zod so the (future)
  recommendation engine can be unit-tested without infrastructure and
  previewed client-side per section 3.2.
- **Toolchain pins** (all verified against the real package registries as of
  2026-08-20, not assumed):
  - Node.js 24.18.0 ("Krypton", current LTS) — `.node-version`, `engines`.
  - Python 3.12.5 — chosen over the system's default 3.14.2 because the
    ML-adjacent ecosystem (Phase 4's scikit-learn/LightGBM/Optuna) has
    deeper 3.12 track record; `.python-version` pins it explicitly.
  - TypeScript **6.0.3**, not the newly-stable-looking 7.0.2. TypeScript 7
    is the native (non-Node) rewrite; `typescript-eslint@8.67.0`'s
    peer range is `>=4.8.4 <6.1.0` and does not support it yet. Per
    BUILD_SPEC.md's "document the conflict, don't silently improvise" rule,
    we pin the newest version inside that supported range (6.0.3) and will
    revisit once typescript-eslint ships TS7 support.

## Consequences

- Every workspace package's `tsconfig.json` needed its own explicit
  `include`/`exclude` — relative paths inside an `extends`-ed base config
  resolve relative to _that base config's own directory_, not the
  extending package. The shared configs in `packages/config-typescript`
  therefore only set `compilerOptions`, never `include`/`exclude`.
- `types: ["node"]` is set in the shared base `tsconfig` because ambient
  `@types/node` auto-inclusion was not reliably picked up in this pnpm
  workspace layout on TypeScript 6.0.3; being explicit removed the
  ambiguity. Packages needing other ambient type packages (e.g. jest-dom's
  Vitest matcher augmentation) include the file that imports them directly
  in their own `include` list instead of relying on the ambient mechanism.
