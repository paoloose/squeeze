import { mkdir, rename, stat, utimes } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { inspectContainer, parseJpeg, rebuild, verifyRebuild, type ContainerInfo } from "./jpeg-container.ts";
import { categories, stripExif } from "./metadata.ts";
import { fit } from "./resolution.ts";
import type { Entry, Options, Outcome } from "./types.ts";
import { dropTmp, makeTmp, run } from "./util.ts";

/** Resampling a JPEG/WebP needs a lossy re-encode; PNG/GIF/TIFF stay lossless (only the resampling loses detail). */
const DEFAULT_RESIZE_QUALITY = 90;
const isLossyFormat = (p: string) => /\.(jpe?g|webp)$/i.test(p);

/** caesiumclt argv. Lossless unless --image-quality was given. `resizeLong` = new long edge in px. */
export function caesiumCommand(o: Options, input: string, outDir: string, resizeLong?: number): string[] {
  const cmd = ["caesiumclt"];
  const quality = o.imageQuality ?? (resizeLong && isLossyFormat(input) ? DEFAULT_RESIZE_QUALITY : undefined);
  if (quality === undefined) cmd.push("--lossless");
  else cmd.push("--quality", String(quality));
  if (resizeLong) cmd.push("--long-edge", String(resizeLong), "--no-upscale");
  cmd.push(
    "--output", outDir,
    "--json",
    "--threads", "1", // we parallelise across files instead
    "--png-opt-level", String(o.pngLevel),
    "--keep-dates",
  );
  // selective keywords only work on JPEG EXIF; for other formats the safe reading of "strip" is to drop everything
  const dropAll = o.strip.has("all") || (o.strip.size > 0 && !/\.jpe?g$/i.test(input));
  if (!dropAll) cmd.push("--exif");
  if (o.zopfli) cmd.push("--zopfli");
  cmd.push(...o.caesiumArgs, input);
  return cmd;
}

/** Stored pixel size (EXIF orientation not applied: only the long/short edges matter to --max-resolution). */
async function imageSize(path: string): Promise<{ w: number; h: number } | undefined> {
  const r = await run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path]);
  const m = r.stdout.trim().match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

async function runCaesium(o: Options, input: string, outDir: string, resizeLong?: number): Promise<string> {
  const r = await run(caesiumCommand(o, input, outDir, resizeLong));
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `caesiumclt exit ${r.code}`);
  const produced = join(outDir, basename(input));
  if (!(await stat(produced).then(() => true, () => false))) throw new Error("caesiumclt produced no output");
  return produced;
}

/** md5 of the decoded pixels (first image only), via ffmpeg. */
async function pixelHash(path: string): Promise<string> {
  const r = await run(["ffmpeg", "-v", "error", "-i", path, "-frames:v", "1", "-f", "md5", "-"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`could not decode ${basename(path)} for verification`);
  return r.stdout.trim();
}

/**
 * JPEG with a gain map / motion video / MPF images appended: optimise only the primary image,
 * keep every metadata segment and the trailing payloads byte-for-byte, patch MPF offsets, verify.
 */
async function compressContainerJpeg(
  e: Entry, o: Options, bytes: Uint8Array, info: ContainerInfo, tmp: string, resizeLong?: number,
): Promise<string> {
  const primaryPath = join(tmp, "primary.jpg");
  await Bun.write(primaryPath, bytes.subarray(0, info.layout.primaryEnd));
  const outDir = join(tmp, "out");
  await mkdir(outDir);
  const optimized = new Uint8Array(await Bun.file(await runCaesium(o, primaryPath, outDir, resizeLong)).arrayBuffer());

  const cats = o.strip.size ? categories(o.strip) : undefined;
  const rebuilt = rebuild(bytes, info, optimized, !!resizeLong, cats);
  verifyRebuild(bytes, info, rebuilt, !!resizeLong || !!cats);

  const finalPath = join(tmp, "final" + extname(e.path));
  await Bun.write(finalPath, rebuilt);
  if (o.imageQuality === undefined && !resizeLong && !o.fast) {
    // lossless mode: the primary must decode to exactly the same pixels (--fast keeps only the structural checks)
    if ((await pixelHash(primaryPath)) !== (await pixelHash(finalPath))) throw new Error("pixel mismatch after rebuild");
  }
  return finalPath;
}

export async function compressImage(e: Entry, o: Options, target: string): Promise<Outcome> {
  const base: Outcome = { entry: e, status: "skipped", target, before: e.size, after: e.size };

  if (!o.replace && !o.overwrite && (await stat(target).then(() => true, () => false))) {
    return { ...base, note: "output exists (use --overwrite)" };
  }

  // JPEGs may carry a gain map / motion video after the image; a plain optimiser would drop it.
  let container: ContainerInfo | undefined;
  let bytes: Uint8Array | undefined;
  if (/\.jpe?g$/i.test(e.path)) {
    bytes = new Uint8Array(await Bun.file(e.path).arrayBuffer());
    try {
      container = inspectContainer(bytes);
    } catch (err) {
      return { ...base, note: `kept to avoid data loss: ${(err as Error).message}` };
    }
  }

  let resizeLong: number | undefined;
  let resizedNote: string | undefined;
  if (o.maxResolution) {
    const size = await imageSize(e.path);
    const f = size && fit(size.w, size.h, o.maxResolution);
    if (size && f) {
      resizeLong = Math.max(f.w, f.h);
      resizedNote = `resized ${size.w}×${size.h} → ${f.w}×${f.h}`;
    }
  }

  await mkdir(dirname(target), { recursive: true });
  const tmp = await makeTmp(dirname(target));
  try {
    let produced: string;
    try {
      produced = container
        ? await compressContainerJpeg(e, o, bytes!, container, tmp, resizeLong)
        : await runCaesium(o, e.path, tmp, resizeLong);
    } catch (err) {
      return { ...base, status: "error", note: (err as Error).message };
    }

    // plain JPEG with selective keywords: caesium kept the EXIF verbatim, so remove the chosen tags now
    if (!container && o.strip.size && !o.strip.has("all") && /\.jpe?g$/i.test(e.path)) {
      try {
        const out = new Uint8Array(await Bun.file(produced).arrayBuffer());
        const exif = parseJpeg(out).segments.find((s) => s.marker === 0xe1 && out[s.start + 4] === 0x45 && out[s.start + 5] === 0x78);
        if (exif) {
          stripExif(out, exif.start, exif.end, categories(o.strip));
          await Bun.write(produced, out);
        }
      } catch (err) {
        return { ...base, status: "error", note: `could not strip metadata, nothing written: ${(err as Error).message}` };
      }
    }
    const after = (await stat(produced)).size;
    const savedPct = ((e.size - after) / e.size) * 100;
    if (after >= e.size || savedPct < o.minSavings) {
      return { ...base, note: `no worthwhile gain (${savedPct.toFixed(1)}% < ${o.minSavings}%)` };
    }
    await rename(produced, target);
    await utimes(target, new Date(), new Date(e.mtimeMs)).catch(() => {});
    // the motion clip is kept byte-for-byte (rewriting it would break the offsets Google Photos relies on)
    const clipWarning = o.strip.size && container?.kinds.includes("motion photo") && "NOTE: embedded motion clip keeps its own date/camera tags";
    const notes = [resizedNote, o.strip.size && `stripped ${[...o.strip].join("+")}`, clipWarning, container && `kept ${container.kinds.join(" + ")}`].filter(Boolean);
    return { ...base, status: "done", after, note: notes.length ? notes.join("; ") : undefined };
  } finally {
    await dropTmp(tmp);
  }
}
