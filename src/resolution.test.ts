import { expect, test } from "bun:test";
import { fit, parseResolution } from "./resolution.ts";

const f = (w: number, h: number, r: string, even = false) => fit(w, h, parseResolution(r), even);

test("parses names, boxes and single numbers", () => {
  expect(parseResolution("2K")).toEqual({ long: 2560, short: 1440 });
  expect(parseResolution("1080x1920")).toEqual({ long: 1920, short: 1080 }); // either order
  expect(parseResolution("2048")).toEqual({ long: 2048, short: Infinity });
  expect(() => parseResolution("huge")).toThrow();
  expect(() => parseResolution("8")).toThrow();
});

test("landscape 4K -> 2k / 1080p", () => {
  expect(f(3840, 2160, "2k")).toEqual({ w: 2560, h: 1440 });
  expect(f(3840, 2160, "1080p")).toEqual({ w: 1920, h: 1080 });
});

test("portrait is handled the same way, just rotated", () => {
  expect(f(2160, 3840, "2k")).toEqual({ w: 1440, h: 2560 });
  expect(f(2160, 3840, "1080p")).toEqual({ w: 1080, h: 1920 });
});

test("never upscales and leaves things that already fit alone", () => {
  expect(f(1920, 1080, "4k")).toBeUndefined();
  expect(f(1080, 1920, "1080p")).toBeUndefined(); // portrait 1080p fits a 1080p box
  expect(f(1280, 720, "1080p")).toBeUndefined();
});

test("odd aspect ratios fit inside the box (the tighter edge wins)", () => {
  expect(f(4000, 3000, "1080p")).toEqual({ w: 1440, h: 1080 }); // 4:3 limited by the short edge
  expect(f(5120, 1440, "1080p")).toEqual({ w: 1920, h: 540 }); // ultrawide limited by the long edge
  expect(f(3000, 3000, "1080p")).toEqual({ w: 1080, h: 1080 }); // square
});

test("single number limits only the long edge", () => {
  expect(f(4032, 3024, "2000")).toEqual({ w: 2000, h: 1500 });
  expect(f(3024, 4032, "2000")).toEqual({ w: 1500, h: 2000 });
});

test("video sizes are rounded to even numbers", () => {
  const r = f(3840, 2160, "1000", true)!;
  expect(r.w % 2).toBe(0);
  expect(r.h % 2).toBe(0);
  expect(r).toEqual({ w: 1000, h: 562 });
});
