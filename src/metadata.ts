/**
 * --strip-metadata <keywords>: remove selected kinds of embedded metadata. Off by default.
 *
 *   gps       location (EXIF GPS block; video location tags)
 *   date      capture dates and time-zone offsets (EXIF dates, sub-seconds; video creation_time)
 *   camera    make, model, serials, lens, MakerNote (video: com.android.* / com.apple.* device tags)
 *   software  firmware / editing software, encoder tags
 *   all       everything above, plus (video) every other tag; (non-JPEG images) all metadata
 */
export const STRIP_CATEGORIES = ["gps", "date", "camera", "software"] as const;
export type StripCategory = (typeof STRIP_CATEGORIES)[number];
export type StripKeyword = StripCategory | "all";

const ALIASES: Record<string, StripKeyword> = { location: "gps", time: "date", dates: "date", device: "camera", encoder: "software" };

export const STRIP_HELP = "gps, date, camera, software, all (comma-separated, repeatable)";

/** Parses "gps,date" (aliases: location, time, device, encoder) and merges with earlier occurrences. */
export function parseStrip(input: string, prev?: Set<StripKeyword>): Set<StripKeyword> {
  const out = new Set<StripKeyword>(prev);
  for (const raw of input.split(",")) {
    const k = raw.trim().toLowerCase();
    if (!k) continue;
    const kw = (ALIASES[k] ?? k) as StripKeyword;
    if (kw !== "all" && !(STRIP_CATEGORIES as readonly string[]).includes(kw)) {
      throw new Error(`unknown metadata keyword "${raw.trim()}". Use ${STRIP_HELP}`);
    }
    out.add(kw);
  }
  if (!out.size) throw new Error(`no keywords given. Use ${STRIP_HELP}`);
  return out;
}

/** `all` expands to every category. */
export function categories(strip: Set<StripKeyword>): Set<StripCategory> {
  return new Set(strip.has("all") ? STRIP_CATEGORIES : ([...strip] as StripCategory[]));
}

// ---------- EXIF (JPEG APP1) ----------

// tags removed per category, by the IFD they live in
const IFD0_TAGS: Record<StripCategory, number[]> = {
  gps: [],
  date: [0x0132], // DateTime
  camera: [0x010f, 0x0110], // Make, Model
  software: [0x0131, 0x013c], // Software, HostComputer
};
const EXIF_TAGS: Record<StripCategory, number[]> = {
  gps: [],
  date: [0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292], // DateTime*, OffsetTime*, SubSecTime*
  camera: [0x927c, 0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435], // MakerNote, owner, body serial, lens spec/make/model/serial
  software: [],
};
const GPS_DATE_TAGS = [0x0007, 0x001d]; // GPSTimeStamp, GPSDateStamp: survive when only `date` is stripped
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

/**
 * Removes the selected tags from the EXIF block at buf[segStart..segEnd) (an APP1 "Exif" segment),
 * IN PLACE and without changing its length: a removed entry is squeezed out of its IFD and both the
 * entry's out-of-line value and the freed bytes are zeroed, so the data is really gone rather than
 * just unreferenced. Returns how many tags were removed.
 */
export function stripExif(buf: Uint8Array, segStart: number, segEnd: number, cats: Set<StripCategory>): number {
  const t = segStart + 10; // FF E1 <len:2> "Exif\0\0"
  if (segEnd - segStart < 18 || String.fromCharCode(...buf.subarray(segStart + 4, segStart + 8)) !== "Exif") {
    throw new Error("not an EXIF segment");
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const le = buf[t] === 0x49;
  if (!le && buf[t] !== 0x4d) throw new Error("bad TIFF byte order");
  const u16 = (p: number) => dv.getUint16(p, le);
  const u32 = (p: number) => dv.getUint32(p, le);
  const w16 = (p: number, v: number) => dv.setUint16(p, v, le);
  const inSeg = (p: number, n: number) => p >= t && p + n <= segEnd;
  const zero = (p: number, n: number) => { if (inSeg(p, n)) buf.fill(0, p, p + n); };
  let removed = 0;

  /** Zero the out-of-line value of the entry at `e` (values <= 4 bytes live inside the entry). */
  const wipeValue = (e: number) => {
    const type = u16(e + 2), count = u32(e + 4);
    const size = (TYPE_SIZE[type] ?? 1) * count;
    if (size > 4) zero(t + u32(e + 8), size);
  };

  /** Remove entries whose tag is in `tags` from the IFD at `ifd`; returns the positions seen (before removal). */
  const prune = (ifd: number, tags: Set<number>, special?: (tag: number, e: number) => boolean) => {
    if (!inSeg(ifd, 2)) return;
    const n = u16(ifd);
    if (!inSeg(ifd, 2 + 12 * n + 4)) throw new Error("EXIF IFD runs past its segment");
    const keep: Uint8Array[] = [];
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + 12 * k;
      const tag = u16(e);
      if (tags.has(tag) || (special && special(tag, e))) {
        wipeValue(e);
        removed++;
      } else keep.push(buf.slice(e, e + 12));
    }
    if (keep.length === n) return;
    const next = buf.slice(ifd + 2 + 12 * n, ifd + 2 + 12 * n + 4); // next-IFD pointer
    w16(ifd, keep.length);
    let p = ifd + 2;
    for (const e of keep) { buf.set(e, p); p += 12; }
    buf.set(next, p);
    zero(p + 4, (n - keep.length) * 12); // freed bytes
  };

  const wanted = (table: Record<StripCategory, number[]>) => new Set([...cats].flatMap((c) => table[c]));
  const ifd0 = t + u32(t + 4);
  if (!inSeg(ifd0, 2)) throw new Error("EXIF IFD0 out of range");

  // locate sub-IFDs and IFD1 before any entries move (their pointers stay valid: only entries shift)
  let exifIfd: number | undefined, gpsIfd: number | undefined;
  for (let k = 0, n = u16(ifd0); k < n; k++) {
    const e = ifd0 + 2 + 12 * k;
    if (u16(e) === 0x8769) exifIfd = t + u32(e + 8);
    if (u16(e) === 0x8825) gpsIfd = t + u32(e + 8);
  }
  const ifd1Off = u32(ifd0 + 2 + 12 * u16(ifd0));
  const ifd1 = ifd1Off ? t + ifd1Off : undefined;

  if (exifIfd !== undefined) prune(exifIfd, wanted(EXIF_TAGS));
  if (gpsIfd !== undefined) {
    if (cats.has("gps")) {
      // wipe the whole GPS block: every value, then the IFD itself
      if (inSeg(gpsIfd, 2)) {
        const n = u16(gpsIfd);
        for (let k = 0; k < n; k++) wipeValue(gpsIfd + 2 + 12 * k);
        zero(gpsIfd, 2 + 12 * n + 4);
        removed++;
      }
    } else if (cats.has("date")) prune(gpsIfd, new Set(GPS_DATE_TAGS));
  }
  if (ifd1 !== undefined) prune(ifd1, wanted(IFD0_TAGS));
  prune(ifd0, wanted(IFD0_TAGS), cats.has("gps") ? (tag) => tag === 0x8825 : undefined);
  return removed;
}

// ---------- video tags ----------

/** Container tags to blank, per category (ffmpeg: `-metadata key=` removes a tag). */
export const VIDEO_TAGS: Record<StripCategory, string[]> = {
  gps: ["location", "location-eng", "com.apple.quicktime.location.ISO6709", "com.apple.quicktime.location.name"],
  date: ["creation_time", "com.apple.quicktime.creationdate"],
  camera: [
    "com.android.model", "com.android.manufacturer", "com.android.capture.fps",
    "com.apple.quicktime.make", "com.apple.quicktime.model",
  ],
  software: ["encoder", "com.android.version", "com.apple.quicktime.software"],
};
