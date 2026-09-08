"use client";

/**
 * Skip-to-content link (Phase 3F accessibility, WCAG 2.4.1).
 *
 * Every DraftCourt route renders its own `<main>` landmark (there is no
 * shared header/nav shell), so the link targets the first `<main>` in the
 * document at activation time rather than a fixed id. Focus is moved
 * programmatically with a transient tabindex so keyboard users land at the
 * page content on every route.
 */
export function SkipLink() {
  return (
    <a
      href="#dc-main-content"
      className="dc-skip-link"
      onClick={(event) => {
        const main = document.querySelector("main");
        if (!main) return; // fall back to the (missing) fragment target
        event.preventDefault();
        if (!main.hasAttribute("tabindex")) {
          main.setAttribute("tabindex", "-1");
          main.setAttribute("data-dc-skip-tabindex", "true");
        }
        main.focus({ preventScroll: false });
      }}
    >
      Skip to main content
    </a>
  );
}
