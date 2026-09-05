import { DemoDraftFlow } from "@/features/drafts/DemoDraftFlow";
import Link from "next/link";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demo Draft — DraftCourt" };

export default function DemoPage() {
  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Demo Draft</h1>
      </header>
      <div className="dc-demo-notice" role="status">
        <svg
          className="dc-demo-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <span>Temporary demo — expires in 24 hours. No account required.</span>
      </div>
      <p className="dc-demo-synthetic" role="note">
        Every statistic, projection, and ADP value is synthetic and generated from a deterministic
        seed for demonstration — see <Link href="/data-sources">/data-sources</Link> and{" "}
        <Link href="/methodology">/methodology</Link>.
      </p>
      <DemoDraftFlow />
      <footer className="dc-demo-footer">
        <p>
          Want to save your drafts and preferences? <Link href="/sign-up">Create an account</Link>{" "}
          (demo drafts are not transferred).
        </p>
      </footer>
    </main>
  );
}
