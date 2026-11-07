import { expect, test } from "bun:test";
import { parseJpeg } from "./jpeg-container.ts";
import { categories, parseStrip, stripExif, type StripCategory } from "./metadata.ts";

const fixture = () => new Uint8Array(require("node:fs").readFileSync(new URL("../test/fixtures/exif-full.jpg", import.meta.url)));

/** Independent EXIF reader: every (ifd, tag) present, following IFD0 -> Exif / GPS / IFD1. */
function readTags(b: Uint8Array): Set<string> {
  const lay = parseJpeg(b);
  const seg = lay.segments.find((s) => s.marker === 0xe1 && b[s.start + 4] === 0x45)!;
  const t = seg.start + 10, dv = new DataView(b.buffer, b.byteOffset);
  const le = b[t] === 0x49, u16 = (p: number) => dv.getUint16(p, le), u32 = (p: number) => dv.getUint32(p, le);
  const out = new Set<string>();
  const walk = (name: string, off: number) => {
    const ifd = t + off; let next = 0;
    for (let k = 0; k < u16(ifd); k++) {
      const e = ifd + 2 + 12 * k, tag = u16(e);
      out.add(`${name}:${tag.toString(16)}`);
      if (tag === 0x8769) walk("exif", u32(e + 8));
      if (tag === 0x8825) walk("gps", u32(e + 8));
    }
    next = u32(ifd + 2 + 12 * u16(ifd));
    return next;
  };
  walk("ifd0", u32(t + 4));
  return out;
}

function strip(...kw: string[]) {
  const b = fixture();
  const lay = parseJpeg(b);
  const seg = lay.segments.find((s) => s.marker === 0xe1 && b[s.start + 4] === 0x45)!;
  const n = stripExif(b, seg.start, seg.end, categories(parseStrip(kw.join(","))));
  return { b, n, tags: readTags(b), seg, orig: fixture() };
}

test("fixture really carries everything we strip", () => {
  const tags = readTags(fixture());
  for (const t of ["ifd0:10f", "ifd0:110", "ifd0:131", "ifd0:132", "exif:9003", "exif:a434", "gps:2", "gps:1d", "ifd0:8825"]) expect(tags.has(t)).toBe(true);
});

test("keyword parsing: aliases, merging, errors", () => {
  expect([...parseStrip("gps,Date")].sort()).toEqual(["date", "gps"]);
  expect([...parseStrip("location, device", parseStrip("software"))].sort()).toEqual(["camera", "gps", "software"]);
  expect(() => parseStrip("gps,wat")).toThrow(/unknown metadata keyword "wat"/);
  expect(() => parseStrip(" , ")).toThrow();
});

test("gps removes the whole GPS block and nothing else", () => {
  const { tags, n } = strip("gps");
  expect(n).toBeGreaterThan(0);
  expect([...tags].filter((t) => t.startsWith("gps:") || t === "ifd0:8825")).toEqual([]);
  for (const keep of ["ifd0:10f", "ifd0:110", "ifd0:131", "ifd0:132", "ifd0:112", "exif:9003", "exif:a434", "exif:829a"]) expect(tags.has(keep)).toBe(true);
});

test("camera removes make/model/lens, keeps dates, software, gps and exposure", () => {
  const { tags } = strip("camera");
  for (const gone of ["ifd0:10f", "ifd0:110", "exif:a433", "exif:a434"]) expect(tags.has(gone)).toBe(false);
  for (const keep of ["ifd0:131", "ifd0:132", "exif:9003", "gps:2", "exif:829a", "exif:8827"]) expect(tags.has(keep)).toBe(true);
});

test("date removes dates, offsets, sub-seconds and GPS date/time but keeps GPS position", () => {
  const { tags } = strip("date");
  for (const gone of ["ifd0:132", "exif:9003", "exif:9004", "exif:9011", "exif:9291", "gps:1d", "gps:7"]) expect(tags.has(gone)).toBe(false);
  for (const keep of ["ifd0:10f", "exif:a434", "gps:2", "gps:4"]) expect(tags.has(keep)).toBe(true);
});

test("software removes only software", () => {
  const { tags } = strip("software");
  expect(tags.has("ifd0:131")).toBe(false);
  for (const keep of ["ifd0:10f", "ifd0:132", "exif:9003", "gps:2"]) expect(tags.has(keep)).toBe(true);
});

test("all four categories: only harmless tags remain, orientation included", () => {
  const { tags } = strip("all");
  for (const gone of ["ifd0:10f", "ifd0:110", "ifd0:131", "ifd0:132", "exif:9003", "exif:a434", "ifd0:8825"]) expect(tags.has(gone)).toBe(false);
  expect(tags.has("ifd0:112")).toBe(true); // Orientation: removing it would rotate the picture
  expect(tags.has("ifd0:13b")).toBe(true); // Artist isn't one of our categories
});

test("removed values are zeroed, not just unreferenced", () => {
  const { b, orig } = strip("all");
  const text = (x: Uint8Array) => Buffer.from(x).toString("latin1");
  for (const secret of ["Pixel 6a", "HDR+ 1.0", "2025:10:16", "back camera", "Google"]) {
    expect(text(orig).includes(secret)).toBe(true);
    expect(text(b).includes(secret)).toBe(false);
  }
  expect(text(b).includes("keep me")).toBe(true);
});

test("segment length is unchanged and the picture still decodes", async () => {
  const { b, orig, seg } = strip("gps", "camera");
  expect(b.length).toBe(orig.length);
  expect(parseJpeg(b).primaryEnd).toBe(parseJpeg(orig).primaryEnd);
  // bytes outside the EXIF segment are untouched
  expect(Buffer.from(b.subarray(seg.end)).equals(Buffer.from(orig.subarray(seg.end)))).toBe(true);
  const dir = (await import("node:os")).tmpdir() + "/strip-test.jpg";
  await Bun.write(dir, b);
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", dir, "-f", "null", "-"]);
  expect(r.exitCode).toBe(0);
  expect(r.stderr.toString()).toBe("");
});

test("stripping nothing wanted changes nothing", () => {
  const b = fixture(), lay = parseJpeg(b);
  const seg = lay.segments.find((s) => s.marker === 0xe1)!;
  expect(stripExif(b, seg.start, seg.end, new Set<StripCategory>())).toBe(0);
  expect(Buffer.from(b).equals(Buffer.from(fixture()))).toBe(true);
});
