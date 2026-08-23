import Link from "next/link";
import { Badge, Card } from "@draftcourt/ui";

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--dc-space-6)",
      }}
    >
      <Card padding="lg">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <h1 style={{ margin: 0, fontSize: "var(--dc-font-size-xl)" }}>DraftCourt</h1>
          <Badge variant="info">Phase 1 — Player experience</Badge>
        </div>
        <p style={{ color: "var(--dc-color-text-secondary)", maxWidth: "32rem" }}>
          Player pool, baseline projections, and comparison tools are live, built on a deterministic
          demo dataset. League setup, live drafts, and roster-aware recommendations ship in later
          phases — see <code>BUILD_SPEC.md</code>.
        </p>
        <nav
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--dc-space-3)",
            marginTop: "var(--dc-space-2)",
          }}
        >
          <Link href="/players" style={{ color: "var(--dc-color-accent)" }}>
            Players
          </Link>
          <Link href="/compare" style={{ color: "var(--dc-color-accent)" }}>
            Compare
          </Link>
          <Link href="/data-sources" style={{ color: "var(--dc-color-accent)" }}>
            Data sources
          </Link>
          <Link href="/methodology" style={{ color: "var(--dc-color-accent)" }}>
            Methodology
          </Link>
          <a href="/api/health" style={{ color: "var(--dc-color-text-secondary)" }}>
            /api/health
          </a>
        </nav>
      </Card>
    </main>
  );
}
