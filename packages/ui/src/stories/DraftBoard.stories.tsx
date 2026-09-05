import type { Meta, StoryObj } from "@storybook/react-vite";
import { DraftBoard } from "../components/DraftBoard";

const meta: Meta<typeof DraftBoard> = {
  title: "Draft/SnakeBoard",
  component: DraftBoard,
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof DraftBoard>;

function makeTeams(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    slot: index + 1,
    displayName:
      index === 7
        ? "Commissioner's Extremely Long Team Name Edition"
        : index === 3
          ? `My Team ${String(index + 1)}`
          : `Manager ${String(index + 1)}`,
    isUserTeam: index === 3,
  }));
}

function makePicks(teams: number, count: number, keepers: number[] = []) {
  const names = [
    "Victor Wembanyama",
    "Luka Dončić",
    "Shai Gilgeous-Alexander",
    "Nikola Jokić",
    "Giannis Antetokounmpo",
    "Jayson Tatum",
    "Anthony Edwards",
    "Tyrese Haliburton",
    "Devin Booker",
    "Trae Young",
    "Paolo Banchero",
    "Scottie Barnes",
    "Alperen Şengün",
    "Jalen Brunson",
    "Donovan Mitchell",
  ];
  return Array.from({ length: count }, (_, index) => {
    const overall = index + 1;
    const round = Math.ceil(overall / teams);
    const positionInRound = ((overall - 1) % teams) + 1;
    // Snake: even rounds reverse slot order.
    const teamSlot = round % 2 === 1 ? positionInRound : teams + 1 - positionInRound;
    return {
      round,
      pickInRound: positionInRound,
      teamSlot,
      overallPick: overall,
      playerName: names[index % names.length] ?? "Unknown player",
      isKeeper: keepers.includes(overall),
    };
  });
}

const twelveTeams = makeTeams(12);

export const TwelveTeamMidDraft: Story = {
  args: {
    teams: twelveTeams,
    rounds: 13,
    picks: makePicks(12, 40, [25]),
    currentOverallPick: 41,
  },
};

export const EmptyFirstRound: Story = {
  args: {
    teams: makeTeams(10),
    rounds: 11,
    picks: [],
    currentOverallPick: 1,
  },
};

export const CompletedDraft: Story = {
  args: {
    teams: makeTeams(8),
    rounds: 4,
    picks: makePicks(8, 32),
    currentOverallPick: 33,
    readOnly: true,
  },
};

export const SixteenTeamLongNames: Story = {
  args: {
    teams: makeTeams(16),
    rounds: 19,
    picks: makePicks(16, 90, [17, 48]),
    currentOverallPick: 91,
  },
};

function DarkWrapper({ children }: { children: React.ReactNode }) {
  // ThemeProvider reads localStorage on mount; set the key before it runs.
  if (typeof window !== "undefined") {
    window.localStorage.setItem("draftcourt-theme-preference", "dark");
  }
  return <>{children}</>;
}

export const DarkThemeMidDraft: Story = {
  args: { ...TwelveTeamMidDraft.args },
  decorators: [
    (Story) => (
      <DarkWrapper>
        <Story />
      </DarkWrapper>
    ),
  ],
};
