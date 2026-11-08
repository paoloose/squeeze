import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { categories, VIDEO_TAGS, type StripKeyword } from "./metadata.ts";
import { fit } from "./resolution.ts";
import type { Entry, Metric, Options, Outcome } from "./types.ts";
import { dropTmp, makeTmp, run, setStatus } from "./util.ts";

/** Which perceptual metric the installed ffmpeg can compute (ab-av1 needs one). */
export async function detectMetrics(): Promise<Set<Metric>> {
  const r = await run(["ffmpeg", "-hide_banner", "-filters"]);
  const found = new Set<Metric>();
  if (/\blibvmaf\b/.test(r.stdout)) found.add("vmaf");
  if (/\bxpsnr\b/.test(r.stdout)) found.add("xpsnr");
  return found;
}

export function pickMetric(o: Options, available: Set<Metric>): Metric {
  if (o.metric !== "auto") {
    if (!available.has(o.metric)) {
      throw new Error(`--metric ${o.metric} requested but this ffmpeg has no ${o.metric === "vmaf" ? "libvmaf" : "xpsnr"} filter`);
    }
    return o.metric;
  }
  if (available.has("vmaf")) return "vmaf";
  if (available.has("xpsnr")) return "xpsnr";
  throw new Error("ffmpeg has neither the libvmaf nor the xpsnr filter; ab-av1 cannot measure quality");
}

export interface VideoInfo {
  codec: string;
  /** Plays taller than wide (after applying rotation metadata). */
  portrait: boolean;
  /** Has data tracks (e.g. Android "mett" camera metadata) that ffmpeg cannot write to any container. */
  hasData: boolean;
  /** Size as displayed (rotation metadata applied). */
  width: number;
  height: number;
}

export async function videoInfo(path: string): Promise<VideoInfo | undefined> {
  const r = await run([
    "ffprobe", "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height:stream_side_data=rotation", "-of", "json", path,
  ]);
  type S = { codec_type?: string; codec_name?: string; width: number; height: number; side_data_list?: { rotation?: number }[] };
  const streams: S[] = (() => { try { return JSON.parse(r.stdout).streams ?? []; } catch { return []; } })();
  const st = streams.find((s) => s.codec_type === "video");
  if (!st?.codec_name) return undefined;
  const hasData = streams.some((s) => s.codec_type === "data");
  const rot = Math.abs(Number(st.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0));
  const sideways = rot % 180 === 90;
  const width = sideways ? st.height : st.width, height = sideways ? st.width : st.height;
  return { codec: st.codec_name, portrait: height > width, hasData, width, height };
}

/*
 * ffmpeg 9.0.2's xpsnr filter returns garbage for portrait frames (an identical file scores
 * ~0.4-9 dB against itself; landscape scores inf). Phone videos are mostly portrait, so every
 * crf "failed" the target and the file was kept. So portrait clips are SEARCHED in landscape
 * (ab-av1 applies --vfilter to the scoring reference too), and the final encode then runs on
 * the frames as displayed. The output is physically portrait with no rotation flag: VLC 3's
 * dav1d module drops the container's orientation, so a flag-based result showed up sideways.
 */
const LANDSCAPE_FILTER = "transpose=cclock";

/** Decoded (display-oriented) frames of a and b must match in size and roughly in content. */
async function sameOrientation(a: string, b: string): Promise<boolean> {
  const r = await run([
    "ffmpeg", "-hide_banner", "-nostats", "-i", a, "-i", b, "-filter_complex",
    // pair frames by index: VFR phone video + a new timebase drifts by a frame if paired by timestamp
    // both scaled to the same small square so a --max-resolution downscale can't break the comparison
    "[0:v]setpts=N/30/TB,scale=256:256,format=yuv420p[a];[1:v]setpts=N/30/TB,scale=256:256,format=yuv420p[b];[a][b]psnr",
    "-frames:v", "10", "-f", "null", "-",
  ]);
  const avg = Number(r.stderr.match(/average:([0-9.]+|inf)/)?.[1]?.replace("inf", "99"));
  return Number.isFinite(avg) && avg > 20; // measured: wrong orientation ~12 dB, mirrored ~17, correct ~40
}

export interface AbAv1Step {
  input: string;
  output: string;
  tempDir: string;
  vfilter?: string;
  dropData?: boolean;
  /** auto = search + encode in one go; search = find the crf only; encode = one encode at `crf`. */
  phase?: "auto" | "search" | "encode";
  crf?: number;
}

export function abav1Command(o: Options, metric: Metric, s: AbAv1Step): string[] {
  const crf = s.crf ?? o.crf; // fixed CRF: found by the search step, or given by --fast / --crf
  const phase = s.phase ?? (crf !== undefined ? "encode" : "auto");
  const sub = { auto: "auto-encode", search: "crf-search", encode: "encode" }[phase];
  const cmd = ["ab-av1", sub, "-i", s.input];
  if (phase !== "search") cmd.push("-o", s.output);
  // a fixed-CRF encode has no sample files, so --temp-dir isn't needed
  if (phase === "encode") cmd.push("--crf", String(crf));
  else cmd.push("--temp-dir", s.tempDir);
  if (phase === "search") cmd.push("--stdout-format", "json");
  // ab-av1 applies --vfilter to the scoring reference too, so the score measures the encode only
  // (not the quality lost by downscaling, which is what --max-resolution asked for).
  if (s.vfilter) cmd.push("--vfilter", s.vfilter);
  // ab-av1 maps every stream; data tracks (Android "mett") make the final mp4/mkv write fail.
  // -dn (not "-map -0:d") because --enc also reaches the sample encodes, which have no -map 0.
  if (s.dropData) cmd.push("--enc", "dn");
  if (phase !== "encode") {
    if (metric === "vmaf") cmd.push("--min-vmaf", String(o.minVmaf));
    else cmd.push("--min-xpsnr", String(o.minXpsnr));
    cmd.push("--max-encoded-percent", String(o.maxEncodedPercent));
  }
  if (o.encoder) cmd.push("--encoder", o.encoder);
  const preset = o.preset ?? (o.fast && !o.encoder ? "10" : undefined); // --fast: a bit larger files, ~2.5x faster
  if (preset) cmd.push("--preset", preset);
  if (phase !== "search") {
    if (o.audioCodec) cmd.push("--acodec", o.audioCodec);
    if (o.verify) cmd.push("--verify");
  }
  cmd.push(...o.abAv1Args);
  return cmd;
}

/** The chosen crf from `ab-av1 crf-search --stdout-format json`. */
function searchedCrf(stdout: string): number | undefined {
  for (const line of stdout.split("\n").reverse()) {
    try {
      const m = JSON.parse(line);
      if (m.type === "crf-search-done" && Number.isFinite(m.crf)) return m.crf;
    } catch { /* not a JSON line */ }
  }
  return undefined;
}

export async function compressVideo(
  e: Entry,
  o: Options,
  target: string,
  metric: Metric,
  label: string,
): Promise<Outcome> {
  const base: Outcome = { entry: e, status: "skipped", target, before: e.size, after: e.size };

  const info = await videoInfo(e.path);
  if (!info) return { ...base, note: "not a readable video (no video stream)" };
  if (!o.includeAv1 && info.codec === "av1") {
    return { ...base, note: "already AV1 (use --include-av1)" };
  }
  if (target !== e.path && (await stat(target).then(() => true, () => false))) {
    if (!o.overwrite) return { ...base, note: `output exists: ${target} (use --overwrite)` };
  }

  await mkdir(dirname(target), { recursive: true });
  const tmp = await makeTmp(dirname(target));
  try {
    const produced = join(tmp, "out" + extname(target));
    const searchInLandscape = info.portrait && metric === "xpsnr" && o.crf === undefined; // only scoring needs it
    const resized = o.maxResolution ? fit(info.width, info.height, o.maxResolution, true) : undefined;
    const scale = (w: number, h: number) => `scale=${w}:${h}:flags=lanczos`;
    // the final encode sees frames as displayed (portrait stays portrait); the search sees them
    // rotated to landscape, which swaps width and height, so its scale target is swapped too
    const encodeFilter = resized ? scale(resized.w, resized.h) : undefined;
    const searchFilter = searchInLandscape
      ? [LANDSCAPE_FILTER, resized && scale(resized.h, resized.w)].filter(Boolean).join(",")
      : encodeFilter;
    if (searchFilter && o.abAv1Args.includes("--vfilter")) {
      return { ...base, status: "error", note: "a custom --vfilter can't be combined with portrait handling or --max-resolution" };
    }
    const onLine = (l: string) => setStatus(`${label} ${l.replace(/^\S+\s+(INFO|WARN)\s+/, "")}`);
    const step = { input: e.path, output: produced, tempDir: tmp, dropData: info.hasData };
    const noCrfMessage = `no encode meets the quality target within ${o.maxEncodedPercent}% of the original size`;
    const failure = (r: { stderr: string; code: number }): Outcome =>
      /Failed to find a suitable crf/i.test(r.stderr)
        ? { ...base, note: noCrfMessage } // nothing to gain
        : { ...base, status: "error", note: abav1Error(r.stderr) ?? `exit ${r.code}` };

    let r;
    if (searchInLandscape) {
      const search = await run(abav1Command(o, metric, { ...step, phase: "search", vfilter: searchFilter }), { onStderrLine: onLine });
      if (search.code !== 0) return failure(search);
      const crf = searchedCrf(search.stdout);
      if (crf === undefined) return { ...base, status: "error", note: "ab-av1 crf-search gave no result" };
      r = await run(abav1Command(o, metric, { ...step, phase: "encode", crf, vfilter: encodeFilter }), { onStderrLine: onLine });
    } else {
      r = await run(abav1Command(o, metric, { ...step, vfilter: encodeFilter }), { onStderrLine: onLine });
    }
    if (r.code !== 0) return failure(r);

    if (!(await stat(produced).then(() => true, () => false))) return { ...base, status: "error", note: "ab-av1 produced no output" };
    if (searchInLandscape && !(await sameOrientation(e.path, produced))) {
      return { ...base, status: "error", note: "orientation check failed; original kept" };
    }
    // metadata first, so the size/savings decision below judges the file we would actually keep
    let tagsNote: string | undefined;
    let kept = produced;
    const tagged = await restoreTags(e.path, produced, tmp, o.strip);
    if (tagged && (await sameStreams(produced, tagged))) kept = tagged;
    else if (o.strip.size) {
      // never fall back to a file that still carries the metadata the user asked to remove
      return { ...base, status: "error", note: "could not strip metadata, nothing written" };
    } else tagsNote = "original tags could not be restored";
    const after = (await stat(kept)).size;
    const savedPct = ((e.size - after) / e.size) * 100;
    if (after >= e.size || savedPct < o.minSavings) {
      return { ...base, note: `no worthwhile gain (${savedPct.toFixed(1)}% < ${o.minSavings}%)` };
    }

    await rename(kept, target);
    if (o.replace && target !== e.path) await rm(e.path); // extension changed, e.g. .avi -> .mkv
    await utimes(target, new Date(), new Date(e.mtimeMs)).catch(() => {});
    const notes = [
      resized && `resized ${info.width}×${info.height} → ${resized.w}×${resized.h}`,
      searchInLandscape && "portrait: searched in landscape",
      o.strip.size && `stripped ${[...o.strip].join("+")}`,
      info.hasData && o.verbose && "dropped camera-metadata track",
      tagsNote,
    ].filter(Boolean);
    return { ...base, status: "done", after, note: notes.length ? notes.join("; ") : undefined };
  } finally {
    await dropTmp(tmp);
  }
}

/*
 * ab-av1/ffmpeg drop most container metadata (creation_time, com.android.* camera tags). Copy the
 * original's tags onto the finished file with a stream-copy remux (seconds, no re-encode). The
 * brand fields are ftyp details ffmpeg reports as tags; writing them back would just duplicate them.
 */
async function restoreTags(original: string, produced: string, dir: string, strip: Set<StripKeyword>): Promise<string | undefined> {
  const ext = extname(produced);
  const out = join(dir, "tagged" + ext);
  const mp4 = ext === ".mp4" ? ["-movflags", "use_metadata_tags+faststart"] : [];

  if (strip.has("all")) {
    // nothing is copied from the original; muxer-added tags (encoder=Lavf...) are suppressed too
    const r = await run([
      "ffmpeg", "-v", "error", "-y", "-i", produced, "-map", "0", "-map_metadata", "-1",
      "-map_metadata:s:v:0", "-1", "-map_metadata:s:a:0", "-1", "-map_chapters", "-1",
      "-c", "copy", "-fflags", "+bitexact", ...mp4, out,
    ]);
    return r.code === 0 ? out : undefined;
  }

  // restore everything from the original, then blank the tags of the chosen categories
  const blank: string[] = [];
  for (const cat of categories(strip)) {
    for (const key of VIDEO_TAGS[cat]) blank.push("-metadata", `${key}=`);
    if (cat === "date") blank.push("-metadata:s:v:0", "creation_time=", "-metadata:s:a:0", "creation_time=");
    if (cat === "software") blank.push("-metadata:s:v:0", "encoder=", "-metadata:s:a:0", "encoder=", "-fflags", "+bitexact");
  }
  const base = [
    "ffmpeg", "-v", "error", "-y", "-i", produced, "-i", original, "-map", "0", "-map_metadata", "1",
    "-c", "copy", "-metadata", "major_brand=", "-metadata", "minor_version=", "-metadata", "compatible_brands=",
    ...mp4, ...blank,
  ];
  const perStream = ["-map_metadata:s:v:0", "1:s:v:0", "-map_metadata:s:a:0", "1:s:a:0"];
  // stream-level creation_time too; if the original has no audio that mapping fails, so retry without it
  for (const extra of [perStream, []]) {
    const r = await run([...base, ...extra, out]);
    if (r.code === 0) return out;
  }
  return undefined;
}

/** Same streams as the encoded file and about the same size, so a bad remux can't slip through. */
async function sameStreams(a: string, b: string): Promise<boolean> {
  const probe = async (p: string) => (await run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", p])).stdout.trim();
  const [pa, pb] = await Promise.all([probe(a), probe(b)]);
  const [sa, sb] = [(await stat(a)).size, (await stat(b)).size];
  return pa === pb && pa !== "" && Math.abs(sa - sb) / sa < 0.01;
}

/** "Error: ffmpeg encode exit code 234 (Could not write header ...)" instead of ab-av1's "------------". */
function abav1Error(stderr: string): string | undefined {
  const lines = stderr.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const main = lines.find((l) => l.startsWith("Error:"));
  const why = [...lines].reverse().find((l) => /could not|invalid|not supported|no such|failed|must match|unknown/i.test(l) && !/^Conversion failed/.test(l));
  return main ? (why ? `${main} (${why.replace(/^\[[^\]]*\]\s*/, "")})` : main) : lines.at(-1);
}

export const describeQuality = (o: Options, metric: Metric) =>
  metric === "vmaf" ? `VMAF ≥ ${o.minVmaf}` : `XPSNR ≥ ${o.minXpsnr} dB`;
