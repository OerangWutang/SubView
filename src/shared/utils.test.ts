import { describe, expect, it, vi } from "vitest";
import { clamp, uid, addDays, parseCsv, uniqueStrings } from "./utils";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to min", () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });

  it("clamps to max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("handles equal min and max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });
});

describe("uid", () => {
  it("generates id with expected format using stubbed values", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    vi.spyOn(Math, "random").mockReturnValue(0.123456789);
    const id = uid();
    expect(id).toBe(`tg_${(1000000).toString(36)}_${(0.123456789).toString(36).slice(2, 8)}`);
    vi.restoreAllMocks();
  });

  it("generates different ids for different random values", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.111111)
      .mockReturnValueOnce(0.999999);
    const id1 = uid();
    const id2 = uid();
    expect(id1).not.toBe(id2);
    vi.restoreAllMocks();
  });

  it("uses custom prefix", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000000);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(uid("rem")).toMatch(/^rem_/);
    vi.restoreAllMocks();
  });
});

describe("addDays", () => {
  it("adds days to a date", () => {
    const base = new Date("2025-01-01T00:00:00Z");
    const result = addDays(base, 7);
    expect(result.toISOString()).toBe("2025-01-08T00:00:00.000Z");
  });

  it("does not mutate the original date", () => {
    const base = new Date("2025-06-15T12:00:00Z");
    addDays(base, 5);
    expect(base.toISOString()).toBe("2025-06-15T12:00:00.000Z");
  });

  it("handles zero days", () => {
    const base = new Date("2025-03-01T00:00:00Z");
    const result = addDays(base, 0);
    expect(result.toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });
});

describe("parseCsv", () => {
  it("splits and trims values", () => {
    expect(parseCsv("a, b , c")).toEqual(["a", "b", "c"]);
  });

  it("removes empty entries", () => {
    expect(parseCsv("a,,b,")).toEqual(["a", "b"]);
  });

  it("lowercases values", () => {
    expect(parseCsv("FOO,Bar")).toEqual(["foo", "bar"]);
  });

  it("deduplicates entries", () => {
    expect(parseCsv("a, a, A")).toEqual(["a"]);
  });
});

describe("uniqueStrings", () => {
  it("removes duplicates and trims", () => {
    expect(uniqueStrings(["a", " a ", "b", "b"])).toEqual(["a", "b"]);
  });

  it("filters out empty strings", () => {
    expect(uniqueStrings(["a", "", " ", "b"])).toEqual(["a", "b"]);
  });
});
