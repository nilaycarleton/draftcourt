import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, serializeTeam } from "@/lib/server/players";

describe("serializeTeam", () => {
  it("returns null for a null team", () => {
    expect(serializeTeam(null)).toBeNull();
  });

  it("picks only the declared safe public fields", () => {
    const result = serializeTeam({
      abbreviation: "BOS",
      name: "Boston Celtics",
      colorPrimary: "#007A33",
      colorSecondary: "#BA9653",
    });
    expect(result).toEqual({
      abbreviation: "BOS",
      name: "Boston Celtics",
      colorPrimary: "#007A33",
      colorSecondary: "#BA9653",
    });
  });

  it("never leaks internal fields present on the input object", () => {
    // Regression guard: an earlier version passed the raw Prisma NbaTeam
    // row straight through (`team: player.currentTeam`), which leaked
    // `id`, `nbaProviderId`, `createdAt`, `updatedAt` into the public API
    // response — caught by hitting the live endpoint, not by typechecking
    // alone, since TS doesn't excess-property-check non-literal values.
    const rawRow = {
      id: "internal-uuid",
      nbaProviderId: "demo-team-BOS",
      abbreviation: "BOS",
      name: "Boston Celtics",
      colorPrimary: "#007A33",
      colorSecondary: "#BA9653",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const result = serializeTeam(rawRow);
    expect(result).not.toHaveProperty("id");
    expect(result).not.toHaveProperty("nbaProviderId");
    expect(result).not.toHaveProperty("createdAt");
    expect(result).not.toHaveProperty("updatedAt");
    expect(Object.keys(result ?? {}).sort()).toEqual(
      ["abbreviation", "colorPrimary", "colorSecondary", "name"].sort(),
    );
  });
});

describe("cursor encode/decode", () => {
  it("round-trips an offset", () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  it("round-trips offset zero", () => {
    expect(decodeCursor(encodeCursor(0))).toBe(0);
  });

  it("returns undefined for a null/undefined cursor", () => {
    expect(decodeCursor(null)).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it("returns undefined for a malformed cursor rather than throwing", () => {
    expect(decodeCursor("not-valid-base64url-json")).toBeUndefined();
  });

  it("returns undefined for a well-formed but wrong-shaped payload", () => {
    const cursor = Buffer.from(JSON.stringify({ notOffset: 1 }), "utf8").toString("base64url");
    expect(decodeCursor(cursor)).toBeUndefined();
  });
});
