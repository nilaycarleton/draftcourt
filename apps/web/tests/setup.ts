import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// jsdom localStorage is not always available in Node test environments.
// Provide a minimal in-memory implementation so modules like mockPacing work.
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

// jsdom does not implement matchMedia; components that read viewport
// media queries (mobile tabs) need a working stub with `.matches` driven
// by window width so tests can simulate narrow screens deterministically.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  const listeners = new Map<EventListenerOrEventListenerObject, Set<string>>();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList => ({
      matches: query.includes("max-width") ? window.innerWidth < 900 : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
        const set = listeners.get(listener) ?? new Set<string>();
        set.add(query);
        listeners.set(listener, set);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject): void => {
        listeners.delete(listener);
      },
      addListener: (): void => undefined,
      removeListener: (): void => undefined,
      dispatchEvent: (): boolean => false,
    }),
  });
}

// ResizeObserver guard for components that observe scroll containers.
if (typeof globalThis.ResizeObserver === "undefined") {
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    value: class {
      /* eslint-disable @typescript-eslint/no-empty-function */
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      /* eslint-enable @typescript-eslint/no-empty-function */
    },
  });
}

// jsdom implements the <dialog> element but not showModal()/close() —
// minimal stand-ins so Astryx Dialog-driven sheets mount in tests.
if (
  typeof window !== "undefined" &&
  typeof HTMLDialogElement !== "undefined" &&
  typeof HTMLDialogElement.prototype.showModal !== "function"
) {
  HTMLDialogElement.prototype.showModal = function showModal(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.show = function show(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(): void {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

afterEach(() => {
  cleanup();
});
