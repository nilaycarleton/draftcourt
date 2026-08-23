import Link from "next/link";

export default function NotFound() {
  return (
    <main className="dc-page">
      <div className="dc-empty-state" role="status">
        <h1>Page not found</h1>
        <p>We couldn&apos;t find what you were looking for.</p>
        <Link href="/players" className="dc-button-primary">
          Browse players
        </Link>
      </div>
    </main>
  );
}
