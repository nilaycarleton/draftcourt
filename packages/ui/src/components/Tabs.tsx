"use client";

import { useCallback, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

/**
 * DraftCourt's accessible tabs contract (WAI-ARIA tabs pattern).
 *
 * Implemented natively rather than over Astryx's `TabList`: that primitive
 * is a navigation list (button/link strip with roving tabindex) and does not
 * expose `role=tablist` / `aria-selected` / `aria-controls` semantics, which
 * BUILD_SPEC.md section 10.4 requires for the mobile draft-room sections.
 * Styling uses DraftCourt tokens only; documented in the Phase 2 Impeccable
 * reports. Single tab stop with Arrow/Home/End roving focus.
 */
export interface DraftCourtTab {
  value: string;
  label: string;
}

export interface TabsProps {
  /** Currently selected tab value (controlled). */
  value: string;
  onChange: (value: string) => void;
  tabs: DraftCourtTab[];
  accessibleLabel: string;
}

export function Tabs({ value, onChange, tabs, accessibleLabel }: TabsProps): ReactNode {
  const listRef = useRef<HTMLDivElement>(null);

  const moveFocus = useCallback((from: number, delta: number): void => {
    if (!listRef.current) return;
    const tabElements = Array.from(
      listRef.current.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (tabElements.length === 0) return;
    const next = (from + delta + tabElements.length) % tabElements.length;
    tabElements[next]?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      const currentIndex = tabs.findIndex((tab) => tab.value === value);
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown": {
          event.preventDefault();
          moveFocus(Math.max(0, currentIndex), 1);
          break;
        }
        case "ArrowLeft":
        case "ArrowUp": {
          event.preventDefault();
          moveFocus(Math.max(0, currentIndex), -1);
          break;
        }
        case "Home": {
          event.preventDefault();
          moveFocus(0, currentIndex === 0 ? 0 : -currentIndex);
          break;
        }
        case "End": {
          event.preventDefault();
          moveFocus(Math.max(0, currentIndex), tabs.length - 1 - Math.max(0, currentIndex));
          break;
        }
        default:
          break;
      }
    },
    [moveFocus, tabs, value],
  );

  return (
    // WAI-ARIA tabs pattern: focus lives on the [role=tab] children
    // (roving tabindex), never on the tablist container itself.
    /* eslint-disable-next-line jsx-a11y/interactive-supports-focus */
    <div
      ref={listRef}
      role="tablist"
      aria-label={accessibleLabel}
      className="dc-tabs"
      onKeyDown={onKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            id={`dc-tab-${tab.value}`}
            aria-selected={selected}
            aria-controls={`dc-panel-${tab.value}`}
            tabIndex={selected ? 0 : -1}
            className={selected ? "dc-tabs-tab dc-tabs-tab-selected" : "dc-tabs-tab"}
            onClick={() => {
              onChange(tab.value);
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
