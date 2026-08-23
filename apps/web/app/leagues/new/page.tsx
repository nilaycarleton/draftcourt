import { LeagueWizard } from "@/features/leagues/LeagueWizard";

export const metadata = { title: "New league — DraftCourt" };

export default function NewLeaguePage() {
  return (
    <main className="dc-page">
      <header className="dc-page-header">
        <h1>Create a league</h1>
        <p className="dc-page-subtitle">
          Points or custom-category snake leagues. Your setup saves as you go.
        </p>
      </header>
      <LeagueWizard />
    </main>
  );
}
