import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// jsdom localStorage is not always available in Node test environments.
// Provide a minimal in-memory implementation so modules like ThemeProvider work.
if (typeof window !== "undefined" && typeof window.localStorage === "undefined") {
  const store = new Map<string, string>();
  const mockStorage: Storage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      store.set(key, value);
    },
    removeItem: (key: string): void => {
      store.delete(key);
    },
    clear(): void {
      store.clear();
    },
    get length(): number {
      return store.size;
    },
    key: (index: number): string | null => [...store.keys()][index] ?? null,
  };
  Object.defineProperty(window, "localStorage", {
    writable: true,
    value: mockStorage,
  });
}

afterEach(() => {
  cleanup();
});
