import { describe, expect, it } from "vitest";
import { compact } from "@/lib/compact";

describe("compact", () => {
  it("removes undefined-valued keys", () => {
    expect(compact({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
  });

  it("keeps falsy-but-defined values", () => {
    expect(compact({ a: 0, b: false, c: "", d: null })).toEqual({ a: 0, b: false, c: "", d: null });
  });

  it("returns an empty object when all values are undefined", () => {
    expect(compact({ a: undefined, b: undefined })).toEqual({});
  });

  it("returns an equivalent object when nothing is undefined", () => {
    expect(compact({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
  });
});
