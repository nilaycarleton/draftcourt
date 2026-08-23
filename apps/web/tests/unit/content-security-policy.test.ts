import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "@/lib/content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it("embeds the given nonce in script-src", () => {
    const csp = buildContentSecurityPolicy("test-nonce-123");
    expect(csp).toContain("'nonce-test-nonce-123'");
  });

  it("never allows 'unsafe-inline' for scripts", () => {
    const csp = buildContentSecurityPolicy("test-nonce-123");
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("denies framing by default", () => {
    const csp = buildContentSecurityPolicy("test-nonce-123");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("produces a different nonce value each call site uses consistently", () => {
    const cspA = buildContentSecurityPolicy("aaa");
    const cspB = buildContentSecurityPolicy("bbb");
    expect(cspA).not.toEqual(cspB);
  });
});
