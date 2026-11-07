import { stripExif, type StripCategory } from "./metadata.ts";
/**
 * Lossless optimisation of "container" JPEGs: a primary JPEG followed by extra payloads
 * (Ultra HDR gain map, Google Motion Photo MP4, MPF secondary images, ...).
 *
 * Layout (Pixel example):   [primary JPEG][gain-map JPEG][motion MP4]
 *   - Container XMP (in the primary's APP1) stores the *lengths* of trailing items, counted from
 *     the end of the file. Legacy GCamera:MicroVideoOffset is also counted from the end.
 *     => valid as long as the trailing bytes are untouched.
 *   - MPF (APP2) stores the *offset* of each secondary image relative to MPF's TIFF header,
 *     and the primary's size. => must be patched when the primary changes size.
 *
 * Strategy: re-encode only the primary's entropy-coded data losslessly, keep every APPn/COM
 * segment byte-for-byte, re-append the trailer byte-for-byte, patch MPF, then verify.
 */

export interface Segment {
  marker: number;
  start: number; // offset of the 0xFF
  end: number; // offset after the segment
}

export interface JpegLayout {
  /** APPn/COM segments before the first codec segment (DQT/SOF/DHT/...). */
  headerEnd: number;
  segments: Segment[];
  /** Offset just past the primary image's EOI. */
  primaryEnd: number;
}

const isApp = (m: number) => (m >= 0xe0 && m <= 0xef) || m === 0xfe;

/** Walk a JPEG from SOI to its EOI, handling progressive (multi-scan) files. */
export function parseJpeg(b: Uint8Array, from = 0): JpegLayout {
  if (b[from] !== 0xff || b[from + 1] !== 0xd8) throw new Error("not a JPEG (no SOI)");
  const segments: Segment[] = [];
  let headerEnd = -1;
  let i = from + 2;
  const len16 = (p: number) => (b[p]! << 8) | b[p + 1]!;

  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`bad marker at ${i}`);
    let m = b[i + 1]!;
    while (m === 0xff) { i++; m = b[i + 1]!; } // fill bytes
    if (m === 0xd9) return { headerEnd, segments, primaryEnd: i + 2 };
    if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; } // stray RST
    const end = i + 2 + len16(i + 2);
    segments.push({ marker: m, start: i, end });
    if (headerEnd < 0 && !isApp(m)) headerEnd = i;
    i = end;
    if (m === 0xda) {
      // entropy-coded data: runs until a marker that is not stuffing (FF00) or RSTn
      while (i < b.length) {
        if (b[i] === 0xff) {
          const n = b[i + 1]!;
          if (n === 0x00 || (n >= 0xd0 && n <= 0xd7) || n === 0xff) { i += n === 0xff ? 1 : 2; continue; }
          break;
        }
        i++;
      }
    }
  }
  throw new Error("no EOI found");
}

// ---------- MPF ----------

interface MpEntry { sizePos: number; offsetPos: number; size: number; offset: number }
/** Positions are absolute in the parsed file; `segStart` lets us relocate them. */
export interface Mpf { segStart: number; tiffPos: number; le: boolean; entries: MpEntry[] }

export function parseMpf(b: Uint8Array, layout: JpegLayout): Mpf | undefined {
  const seg = layout.segments.find(
    (s) => s.marker === 0xe2 && b[s.start + 4] === 0x4d && b[s.start + 5] === 0x50 && b[s.start + 6] === 0x46 && b[s.start + 7] === 0,
  );
  if (!seg) return undefined;
  const t = seg.start + 8;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const le = b[t] === 0x49;
  const u16 = (p: number) => dv.getUint16(p, le);
  const u32 = (p: number) => dv.getUint32(p, le);
  const ifd = t + u32(t + 4);
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + 12 * k;
    if (u16(e) !== 0xb002) continue;
    const count = u32(e + 4);
    const base = t + u32(e + 8);
    const entries: MpEntry[] = [];
    for (let j = 0; j < count / 16; j++) {
      const p = base + 16 * j;
      entries.push({ sizePos: p + 4, offsetPos: p + 8, size: u32(p + 4), offset: u32(p + 8) });
    }
    return { segStart: seg.start, tiffPos: t, le, entries };
  }
  return { segStart: seg.start, tiffPos: t, le, entries: [] };
}

// ---------- trailer description (Container XMP / MicroVideo) ----------

function xmpText(b: Uint8Array, layout: JpegLayout): string {
  const dec = new TextDecoder("latin1");
  return layout.segments
    .filter((s) => s.marker === 0xe1)
    .map((s) => dec.decode(b.subarray(s.start + 4, s.end)))
    .filter((t) => t.startsWith("http://ns.adobe.com/xap/1.0/"))
    .join("\n");
}

/** Bytes after the primary that some metadata claims, measured back from the end of the file. */
/** Read an XMP property written either as an attribute or as an element. */
function xmpProp(xml: string, name: string): string | undefined {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"|<${name}>\\s*([^<]*?)\\s*</${name}>`);
  const m = xml.match(re);
  return m ? (m[1] ?? m[2]) : undefined;
}

export function containerItems(xmp: string): { semantic?: string; mime?: string; length: number; padding: number }[] {
  const re = /<Container:Item\b(?:[^>]*\/>|[\s\S]*?<\/Container:Item>)/g;
  return [...xmp.matchAll(re)].map(([item]) => ({
    semantic: xmpProp(item, "Item:Semantic"),
    mime: xmpProp(item, "Item:Mime"),
    length: Number(xmpProp(item, "Item:Length") ?? 0),
    padding: Number(xmpProp(item, "Item:Padding") ?? 0),
  }));
}

function describedTrailerBytes(xmp: string): number {
  let total = 0;
  for (const it of containerItems(xmp)) {
    if (it.semantic === "Primary") continue;
    total += it.length + it.padding;
  }
  const micro = xmpProp(xmp, "GCamera:MicroVideoOffset")?.match(/^(\d+)$/);
  if (micro) total = Math.max(total, Number(micro[1]));
  return total;
}

export interface ContainerInfo {
  layout: JpegLayout;
  mpf?: Mpf;
  trailerLen: number;
  kinds: string[]; // human-readable, e.g. ["gain map", "motion photo"]
}

/** undefined => plain JPEG (nothing after EOI). Throws if there is trailing data we don't understand. */
export function inspectContainer(b: Uint8Array): ContainerInfo | undefined {
  const layout = parseJpeg(b);
  const trailerLen = b.length - layout.primaryEnd;
  if (trailerLen === 0) return undefined;
  const mpf = parseMpf(b, layout);
  const xmp = xmpText(b, layout);

  const kinds: string[] = [];
  const items = containerItems(xmp);
  if (items.some((i) => i.semantic === "GainMap") || xmpProp(xmp, "hdrgm:Version")) kinds.push("gain map");
  if (items.some((i) => i.mime?.startsWith("video/")) || xmpProp(xmp, "GCamera:MotionPhoto") === "1" ||
      xmpProp(xmp, "GCamera:MicroVideo") === "1") kinds.push("motion photo");

  // every MPF secondary image must live in the trailer and start with SOI
  const secondaries = (mpf?.entries ?? []).slice(1).filter((e) => e.offset !== 0);
  for (const e of secondaries) {
    const abs = mpf!.tiffPos + e.offset;
    if (abs < layout.primaryEnd || abs + 3 > b.length || b[abs] !== 0xff || b[abs + 1] !== 0xd8) {
      throw new Error("MPF points inside the primary image or at no image");
    }
  }
  const described = describedTrailerBytes(xmp);
  const mpfCovered = secondaries.length > 0;
  if (described > trailerLen) throw new Error("metadata describes more trailing data than exists");
  if (!mpfCovered && described === 0) throw new Error(`${trailerLen} B of unknown data after the image`);
  if (!kinds.length) kinds.push(mpfCovered ? "MPF images" : "embedded data");
  return { layout, mpf, trailerLen, kinds };
}

/**
 * Build the output: original header segments + optimised codec segments + original trailer,
 * with MPF patched. `optimized` is a full JPEG produced by a lossless optimiser from the primary.
 */
export function rebuild(
  orig: Uint8Array, info: ContainerInfo, optimized: Uint8Array, resized = false, strip?: Set<StripCategory>,
): Uint8Array {
  const opt = parseJpeg(optimized);
  if (opt.headerEnd < 0) throw new Error("optimised JPEG without codec segments");

  // keep every metadata segment of the original (some editors put MPF after DQT/DHT)
  const meta = metaSegments(info.layout);
  const headerLen = 2 + meta.reduce((n, s) => n + (s.end - s.start), 0);
  const header = new Uint8Array(headerLen);
  header.set([0xff, 0xd8], 0);
  let pos = 2;
  let mpfShift = 0; // new position - old position of the MPF segment
  for (const s of meta) {
    if (info.mpf && s.start === info.mpf.segStart) mpfShift = pos - s.start;
    header.set(orig.subarray(s.start, s.end), pos);
    pos += s.end - s.start;
  }
  {
    let exifAt = -1, exifLen = 0, p = 2;
    for (const s of meta) { if (isExif(orig, s)) { exifAt = p; exifLen = s.end - s.start; } p += s.end - s.start; }
    if (exifAt >= 0) {
      if (resized) {
        // the copied EXIF still names the old pixel size: keep those tags honest
        const dims = sofSize(optimized, opt);
        if (dims) patchExifDims(header, exifAt, dims.w, dims.h);
      }
      if (strip?.size) stripExif(header, exifAt, exifAt + exifLen, strip); // --strip-metadata, same length
    }
  }
  // optimiser output: drop its own metadata, keep codec segments + scan data
  const codec = optimized.subarray(opt.headerEnd, opt.primaryEnd);
  const trailer = orig.subarray(info.layout.primaryEnd);
  const newPrimaryLen = headerLen + codec.length;

  if (info.mpf) {
    const m = info.mpf;
    const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const newTiff = m.tiffPos + mpfShift;
    m.entries.forEach((e, j) => {
      if (j === 0) {
        if (e.size) dv.setUint32(e.sizePos + mpfShift, e.size + (newPrimaryLen - info.layout.primaryEnd), m.le);
      } else if (e.offset) {
        const inTrailer = m.tiffPos + e.offset - info.layout.primaryEnd; // where the image sits in the trailer
        dv.setUint32(e.offsetPos + mpfShift, newPrimaryLen + inTrailer - newTiff, m.le);
      }
    });
  }

  const out = new Uint8Array(newPrimaryLen + trailer.length);
  out.set(header, 0);
  out.set(codec, headerLen);
  out.set(trailer, newPrimaryLen);
  return out;
}

/** APPn/COM segments located before the first SOS. */
function metaSegments(layout: JpegLayout): Segment[] {
  const sos = layout.segments.findIndex((s) => s.marker === 0xda);
  return layout.segments.slice(0, sos < 0 ? undefined : sos).filter((s) => isApp(s.marker));
}

/** Structural self-check of a rebuilt file against the original. Throws on mismatch. */
export function verifyRebuild(orig: Uint8Array, info: ContainerInfo, out: Uint8Array, exifMayDiffer = false) {
  const lay = parseJpeg(out);
  if (out.length - lay.primaryEnd !== info.trailerLen) throw new Error("trailer length changed");
  const a = orig.subarray(info.layout.primaryEnd);
  const b = out.subarray(lay.primaryEnd);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) throw new Error("trailer bytes changed");
  // metadata segments byte-identical (except the MPF entries we patched), same order
  const om = metaSegments(info.layout), nm = metaSegments(lay);
  if (om.length !== nm.length) throw new Error("metadata segment count changed");
  const mpf = parseMpf(out, lay);
  if (!!mpf !== !!info.mpf) throw new Error("MPF lost");
  om.forEach((s, k) => {
    const n = nm[k]!;
    if (s.end - s.start !== n.end - n.start) throw new Error("metadata segment size changed");
    if (info.mpf && s.start === info.mpf.segStart) return;
    if (exifMayDiffer && isExif(orig, s)) {
      // resized / stripped: the tag contents may change, but not the segment header or the TIFF header
      for (let i = 0; i < 18; i++) if (orig[s.start + i] !== out[n.start + i]) throw new Error("EXIF header changed");
      return;
    }
    for (let i = 0; i < s.end - s.start; i++) if (orig[s.start + i] !== out[n.start + i]) throw new Error("metadata changed");
  });
  // each MPF secondary image must point at the same place in the (unchanged) trailer
  mpf?.entries.forEach((e, j) => {
    const o = info.mpf!.entries[j]!;
    if (j === 0 || !o.offset) return;
    const oldRel = info.mpf!.tiffPos + o.offset - info.layout.primaryEnd;
    const newRel = mpf.tiffPos + e.offset - lay.primaryEnd;
    if (oldRel !== newRel) throw new Error("MPF offset not patched correctly");
    const p = mpf.tiffPos + e.offset;
    if (out[p] !== 0xff || out[p + 1] !== 0xd8) throw new Error("MPF offset does not point at SOI");
  });
}

// ---------- EXIF pixel-size tags (only touched when the image was resized) ----------

const isExif = (b: Uint8Array, s: Segment) =>
  s.marker === 0xe1 && b[s.start + 4] === 0x45 && b[s.start + 5] === 0x78 && b[s.start + 6] === 0x69 && b[s.start + 7] === 0x66;

/** Width/height from the first SOF segment. */
function sofSize(b: Uint8Array, layout: JpegLayout): { w: number; h: number } | undefined {
  const s = layout.segments.find((x) => x.marker >= 0xc0 && x.marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(x.marker));
  return s ? { h: (b[s.start + 5]! << 8) | b[s.start + 6]!, w: (b[s.start + 7]! << 8) | b[s.start + 8]! } : undefined;
}

/**
 * Rewrite ImageWidth/ImageLength (IFD0) and PixelXDimension/PixelYDimension (Exif IFD) in place.
 * Only touches entries holding a single inline SHORT/LONG, so no sizes or offsets change.
 */
function patchExifDims(header: Uint8Array, exifPosInHeader: number, w: number, h: number): void {
  const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const t = exifPosInHeader + 10; // after FF E1 <len> "Exif\0\0"
  const le = header[t] === 0x49;
  const u16 = (p: number) => dv.getUint16(p, le);
  const u32 = (p: number) => dv.getUint32(p, le);
  const setVal = (entry: number, v: number) => {
    const type = u16(entry + 2), count = u32(entry + 4);
    if (count !== 1) return;
    if (type === 3) dv.setUint16(entry + 8, v, le);
    else if (type === 4) dv.setUint32(entry + 8, v, le);
  };
  const walk = (ifdOff: number, tags: Record<number, number>): number | undefined => {
    const ifd = t + ifdOff;
    if (ifd + 2 > header.length) return undefined;
    let exifIfd: number | undefined;
    for (let k = 0, n = u16(ifd); k < n; k++) {
      const e = ifd + 2 + 12 * k;
      if (e + 12 > header.length) break;
      const tag = u16(e);
      if (tag in tags) setVal(e, tags[tag]!);
      if (tag === 0x8769) exifIfd = u32(e + 8);
    }
    return exifIfd;
  };
  const exifIfd = walk(u32(t + 4), { 0x0100: w, 0x0101: h });
  if (exifIfd !== undefined) walk(exifIfd, { 0xa002: w, 0xa003: h });
}
