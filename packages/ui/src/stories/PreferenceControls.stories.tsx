import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { FactorSliderRow, PresetGallery, RankListEditor } from "../components/PreferenceControls";

const meta: Meta = {
  title: "Preference Controls",
  parameters: { layout: "padded" },
};
export default meta;

function FactorSlidersDemo() {
  const [values, setValues] = useState<Record<string, number>>({
    production: 0.33,
    scarcity: 0.11,
    risk: 0.08,
  });
  const [locked, setLocked] = useState<Record<string, boolean>>({ production: true });
  return (
    <div style={{ display: "grid", gap: 8, maxWidth: 560 }}>
      {["production", "scarcity", "risk"].map((factor) => (
        <FactorSliderRow
          key={factor}
          label={factor.charAt(0).toUpperCase() + factor.slice(1)}
          value={values[factor] ?? 0}
          locked={Boolean(locked[factor])}
          onValueChange={(value) => {
            setValues((previous) => ({ ...previous, [factor]: value }));
          }}
          onToggleLock={() => {
            setLocked((previous) => ({ ...previous, [factor]: !previous[factor] }));
          }}
        />
      ))}
    </div>
  );
}

export const FactorSliders: StoryObj = { render: () => <FactorSlidersDemo /> };

function PresetGalleryDemo() {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  return (
    <PresetGallery
      activeKey={activeKey}
      presets={[
        { key: "balanced", title: "Balanced", explanation: "The default blend of factors." },
        { key: "win-now", title: "Win Now", explanation: "Safety today over upside." },
        { key: "dynasty-youth", title: "Dynasty Youth", explanation: "Age curve dominates." },
        { key: "low-risk", title: "Low Risk", explanation: "Durable and consistent." },
      ]}
      onApply={setActiveKey}
    />
  );
}

export const PresetGalleryDefault: StoryObj = { render: () => <PresetGalleryDemo /> };

function RankListDemo() {
  const [items, setItems] = useState([
    { playerId: "a", displayName: "Nikola Jokic" },
    { playerId: "b", displayName: "Luka Doncic" },
    { playerId: "c", displayName: "Shai Gilgeous-Alexander" },
  ]);
  return (
    <div style={{ maxWidth: 640 }}>
      <h3 id="rank-label">My global board</h3>
      <RankListEditor
        items={items}
        notes={{}}
        labelId="rank-label"
        onMove={(playerId, direction) => {
          setItems((previous) => {
            const index = previous.findIndex((item) => item.playerId === playerId);
            const target = direction === "up" ? index - 1 : index + 1;
            if (index < 0 || target < 0 || target >= previous.length) return previous;
            const next = [...previous];
            const removed = next.splice(index, 1);
            const moved = removed[0];
            if (moved === undefined) return previous;
            next.splice(target, 0, moved);
            return next;
          });
        }}
        onRemove={(playerId) => {
          setItems((previous) => previous.filter((item) => item.playerId !== playerId));
        }}
        onNoteChange={() => undefined}
      />
    </div>
  );
}

export const RankList: StoryObj = { render: () => <RankListDemo /> };
