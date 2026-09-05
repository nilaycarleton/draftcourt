import { getCurrentUser } from "@/lib/server/auth";
import { PreferencesWorkspace } from "@/features/preferences/PreferencesWorkspace";

export const dynamic = "force-dynamic";
export const metadata = { title: "Preferences — DraftCourt" };

export default async function PreferencesPage() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <main className="dc-page">
        <header className="dc-page-header">
          <h1>Preferences</h1>
        </header>
        <p className="dc-hint">Sign in to manage your strategy profiles.</p>
      </main>
    );
  }
  return (
    <main className="dc-page">
      <PreferencesWorkspace />
    </main>
  );
}
