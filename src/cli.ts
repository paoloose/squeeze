#!/usr/bin/env bun
import { availableParallelism } from "node:os";
import { relative, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { parseStrip, STRIP_HELP, type StripKeyword } from "./metadata.ts";
import { describeBox, parseResolution, RESOLUTION_HELP } from "./resolution.ts";
import { LEVEL_SPECS, LEVELS, levelHelp, type Level } from "./quality.ts";
import { generateCompletion, SHELLS, type Shell } from "./completion.ts";
import { copyThrough } from "./copy.ts";
import { caesiumCommand, compressImage } from "./image.ts";
import { targetFor } from "./plan.ts";
import { scan } from "./scan.ts";
import type { Entry, Metric, Options, Outcome } from "./types.ts";
import {
  c, clearStatusLine, fmtBytes, fmtPct, installSignalHandlers, log, logErr, pool, setStatusEnabled, shellQuote,
  splitArgs,
} from "./util.ts";
import { abav1Command, compressVideo, describeQuality, detectMetrics, pickMetric } from "./video.ts";

// ---------- option parsing ----------

const num = (min: number, max: number, int = false) => (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    throw new InvalidArgumentError(`expected ${int ? "an integer" : "a number"} between ${min} and ${max}`);
  }
  return n;
};
const collect = (v: string, prev: string[]) => [...prev, v];

const program = new Command()
  .name("squeeze")
  .description(
    "Recursively shrink images (caesiumclt) and videos (ab-av1) without visible quality loss. " +
      "Images are compressed losslessly by default; videos are re-encoded to AV1 at the smallest size that still " +
      "meets a perceptual quality target (never bit-exact, so the target is tunable). " +
      "Nothing is overwritten by default: results go to <dir>.squeezed/ (or <file>.squeezed.<ext>), " +
      "and files that can't be compressed are copied there as-is so the output is a complete mirror.",
  )
  .argument("[paths...]", "files and/or directories to process (use . for the current directory)")
  .showHelpAfterError()
  .configureHelp({ sortOptions: false });

const opt = (flags: string, desc: string, group: string) => new Option(flags, desc).helpGroup(group);
const G = { gen: "General:", out: "Output:", img: "Images (caesiumclt):", vid: "Videos (ab-av1):" };

program
  .addOption(opt("--quality <level>", "how hard to compress: max, high, medium or low (see below)", G.gen).choices([...LEVELS]).default("high"))
  .addOption(opt("--max-resolution <size>", `downscale anything bigger, images and video, any orientation: ${RESOLUTION_HELP}`, G.gen).argParser((s: string) => {
    try { return parseResolution(s); } catch (e) { throw new InvalidArgumentError((e as Error).message); }
  }))
  .addOption(opt("--strip-metadata <keywords>", `remove embedded metadata, images and video (off by default): ${STRIP_HELP}`, G.gen).argParser(
    (s: string, prev?: Set<StripKeyword>) => {
      try { return parseStrip(s, prev); } catch (e) { throw new InvalidArgumentError((e as Error).message); }
    },
  ))
  .addOption(opt("--fast", "much faster: videos get one fixed-CRF encode (no quality search), PNGs use a lighter level, fewer image checks", G.gen))
  .addOption(opt("-n, --dry-run", "show what would be processed and where results would go; write nothing", G.gen))
  .addOption(opt("--no-recursive", "do not descend into subdirectories", G.gen))
  .addOption(opt("--only-images", "compress only images (videos are copied as-is)", G.gen).conflicts("onlyVideos"))
  .addOption(opt("--only-videos", "compress only videos (images are copied as-is)", G.gen).conflicts("onlyImages"))
  .addOption(opt("-x, --exclude <glob>", "skip paths matching a glob (repeatable), e.g. -x 'raw/**' -x '*.gif'", G.gen).default([]).argParser(collect))
  .addOption(opt("--hidden", "also scan hidden files and directories", G.gen))
  .addOption(opt("--no-copy-others", "don't copy unknown/uncompressible files into the output dir (default: copy them)", G.out))
  .addOption(opt("--min-savings <percent>", "discard results that save less than this", G.gen).default(2).argParser(num(0, 100)))
  .addOption(opt("-j, --jobs <n>", "parallel image jobs", G.gen).default(availableParallelism()).argParser(num(1, 256, true)))
  .addOption(opt("--video-jobs <n>", "parallel video encodes; 2 keeps the CPU busy while the other scores quality", G.gen).default(2).argParser(num(1, 16, true)))
  .addOption(opt("--completion <shell>", "print a shell completion script (bash, zsh or fish) and exit", G.gen).choices([...SHELLS]))
  .addOption(opt("-v, --verbose", "print the exact commands that are run", G.gen))
  .addOption(opt("-q, --quiet", "only print the summary and errors", G.gen))
  .addOption(opt("--json", "machine-readable report on stdout", G.gen))

  .addOption(opt("--replace", "replace originals in place (atomic; only when the result is smaller)", G.out))
  .addOption(opt("-o, --out <dir>", "write results under <dir>, mirroring the input structure", G.out))
  .addOption(opt("--overwrite", "overwrite existing output files instead of skipping them", G.out))

  .addOption(opt("--image-quality <0-100|lossless>", "override --quality for images: lossy quality, or 'lossless'", G.img).argParser((s: string) => (s === "lossless" ? "lossless" : num(0, 100, true)(s))))

  .addOption(opt("--png-level <0-6>", "PNG optimisation level, higher = smaller/slower (default 3, or 1 with --fast)", G.img).argParser(num(0, 6, true)))
  .addOption(opt("--zopfli", "zopfli PNG compression (much slower, a bit smaller)", G.img))
  .addOption(opt("--caesium-args <string>", "extra raw arguments for caesiumclt", G.img).default("").argParser(String))

  .addOption(opt("--metric <name>", "quality metric: vmaf needs an ffmpeg built with libvmaf", G.vid).choices(["auto", "vmaf", "xpsnr"]).default("auto"))
  .addOption(opt("--min-vmaf <n>", "override --quality: minimum VMAF (only used when the metric is vmaf)", G.vid).argParser(num(0, 100)))
  .addOption(opt("--min-xpsnr <dB>", "override --quality: minimum XPSNR (only used when the metric is xpsnr)", G.vid).argParser(num(0, 100)))
  .addOption(opt("--crf <n>", "encode videos once at this fixed CRF instead of searching (SVT-AV1: lower = better; --fast picks one per level)", G.vid).argParser(num(0, 63)))
  .addOption(opt("--max-encoded-percent <n>", "give up if the encode would exceed this % of the original size", G.vid).default(90).argParser(num(1, 100)))
  .addOption(opt("-e, --encoder <name>", "ffmpeg encoder (default libsvtav1)", G.vid))
  .addOption(opt("--preset <p>", "encoder preset: lower = smaller/slower (svt-av1: 0-13, default 8)", G.vid))
  .addOption(opt("--acodec <codec>", "audio codec (default: copy the original audio)", G.vid))
  .addOption(opt("--no-verify", "skip the decode/duration check on finished encodes", G.vid))
  .addOption(opt("--include-av1", "re-encode videos that are already AV1", G.vid))
  .addOption(opt("--ab-av1-args <string>", "extra raw arguments for ab-av1 auto-encode, e.g. '--svt film-grain=8'", G.vid).default("").argParser(String))
  .addHelpText(
    "after",
    `
Quality levels (--quality; videos use VMAF or XPSNR, whichever this ffmpeg supports):
${levelHelp().replace(/^/gm, "  ")}

Examples:
  squeeze .                       lossless-compress everything under the current directory
  squeeze -n ~/Pictures           preview, touching nothing
  squeeze --replace photos/       shrink in place (originals only replaced if smaller)
  squeeze --max-resolution 1080p --quality medium .   downscale 4K to 1080p (portrait too)
  squeeze --fast --quality medium ~/Videos       no quality search: much quicker, less predictable sizes
  squeeze --quality medium ~/Videos             smaller files, still hard to tell apart
  squeeze --quality low --image-quality lossless .   shrink videos hard, keep photos lossless
`,
  )
  .version("0.1.0");

// no arguments at all => show help instead of silently touching the current directory
if (process.argv.length <= 2) program.help();

program.parse();

if (program.opts().completion) {
  process.stdout.write(generateCompletion(program.opts().completion as Shell, program));
  process.exit(0);
}

function buildOptions(): Options {
  const v = program.opts();
  const quality = v.quality as Level;
  const L = LEVEL_SPECS[quality];
  const imageQuality = v.imageQuality === "lossless" ? undefined : (v.imageQuality ?? L.image);
  return {
    quality,
    explicitVmaf: v.minVmaf !== undefined,
    explicitXpsnr: v.minXpsnr !== undefined,
    maxResolution: v.maxResolution,
    fast: !!v.fast || v.crf !== undefined,
    crf: v.crf ?? (v.fast ? L.crf : undefined),
    dryRun: !!v.dryRun,
    replace: !!v.replace,
    out: v.out,
    overwrite: !!v.overwrite,
    recursive: v.recursive,
    hidden: !!v.hidden,
    copyOthers: v.copyOthers,
    only: v.onlyImages ? "images" : v.onlyVideos ? "videos" : undefined,
    exclude: v.exclude,
    minSavings: v.minSavings,
    jobs: v.jobs,
    videoJobs: v.videoJobs,
    verbose: !!v.verbose,
    quiet: !!v.quiet || !!v.json,
    json: !!v.json,
    imageQuality,
    strip: (v.stripMetadata as Set<StripKeyword> | undefined) ?? new Set<StripKeyword>(),
    pngLevel: v.pngLevel ?? (v.fast ? 1 : 3),
    zopfli: !!v.zopfli,
    caesiumArgs: splitArgs(v.caesiumArgs),
    metric: v.metric,
    minVmaf: v.minVmaf ?? L.vmaf,
    minXpsnr: v.minXpsnr ?? L.xpsnr,
    encoder: v.encoder,
    preset: v.preset,
    maxEncodedPercent: v.maxEncodedPercent,
    audioCodec: v.acodec,
    verify: v.verify,
    includeAv1: !!v.includeAv1,
    abAv1Args: splitArgs(v.abAv1Args),
  };
}

// ---------- main ----------

const cwd = process.cwd();
const rel = (p: string) => relative(cwd, p) || ".";

function printOutcome(r: Outcome, idx: number, total: number, o: Options) {
  if (o.json || (o.quiet && r.status !== "error")) return; // --json: stdout is JSON only
  const n = c.dim(`[${idx}/${total}]`);
  const name = rel(r.entry.path);
  switch (r.status) {
    case "done":
      log(`${c.green("✔")} ${n} ${name}  ${fmtBytes(r.before)} → ${fmtBytes(r.after)}  ${c.green(fmtPct(r.before, r.after))}` +
        (r.note ? c.dim(`  (${r.note})`) : "") +
        (r.target !== r.entry.path ? c.dim(`  → ${rel(r.target!)}`) : ""));
      break;
    case "skipped":
      log(`${c.yellow("•")} ${n} ${name}  ${c.dim(`kept (${r.note})`)}`);
      break;
    case "planned":
      log(`${c.cyan("○")} ${n} ${name}  ${fmtBytes(r.before)}  ${c.dim("→ " + (r.target === r.entry.path ? "replace in place" : rel(r.target!)))}`);
      if (o.verbose && r.command) log(c.dim(`    $ ${shellQuote(r.command)}`));
      break;
    case "error":
      log(`${c.red("✖")} ${n} ${name}  ${c.red(r.note ?? "failed")}`);
      break;
  }
  if (o.verbose && r.status !== "planned" && r.command) log(c.dim(`    $ ${shellQuote(r.command)}`));
}

function need(bin: string) {
  if (!Bun.which(bin)) throw new Error(`'${bin}' not found in PATH`);
}

async function main() {
  const o = buildOptions();
  if (o.replace && o.out) throw new Error("--replace and --out are mutually exclusive");
  setStatusEnabled(!o.quiet);
  installSignalHandlers();

  const inputs = program.args.length ? program.args : ["."]; // e.g. `squeeze -n` with only flags => cwd
  const skipAbs = o.out ? [resolve(o.out)] : [];
  const entries = await scan(inputs, o, skipAbs);

  const images = entries.filter((e) => e.kind === "image");
  const videos = entries.filter((e) => e.kind === "video");
  const others = entries.filter((e) => e.kind === "other");
  if (!images.length && !videos.length && !others.length) {
    if (o.json) log(JSON.stringify({ dryRun: o.dryRun, files: [], summary: {} }));
    else log("Nothing to do: no supported images or videos found.");
    return 0;
  }

  // preflight
  let metric: Metric = "vmaf";
  if (images.length) need("caesiumclt");
  if (videos.length) {
    for (const b of ["ab-av1", "ffmpeg", "ffprobe"]) need(b);
    if (o.fast && o.encoder && program.opts().crf === undefined) {
      throw new Error("--fast with --encoder needs an explicit --crf (CRF scales differ between encoders)");
    }
    // a fixed CRF is never scored, so the metric (and its ffmpeg filter) isn't needed
    if (o.crf === undefined) metric = pickMetric(o, await detectMetrics());
    const unused = o.crf !== undefined ? (o.explicitVmaf && "--min-vmaf") || (o.explicitXpsnr && "--min-xpsnr") : metric === "xpsnr" ? o.explicitVmaf && "--min-vmaf" : o.explicitXpsnr && "--min-xpsnr";
    if (unused) {
      logErr(c.yellow(`warning: ${unused} is ignored: this run measures quality with ${metric.toUpperCase()}` +
        (metric === "xpsnr" ? " (ffmpeg has no libvmaf). Use --quality or --min-xpsnr." : ". Use --quality or --min-vmaf.")));
    }
  }

  const multiRoot = inputs.length > 1;
  const sum = (es: Entry[]) => es.reduce((a, e) => a + e.size, 0);
  if (!o.quiet) {
    const where = o.replace ? c.red("replacing originals in place") : o.out ? `writing to ${rel(resolve(o.out))}/` : "writing to <dir>.squeezed/ (originals untouched)";
    log(c.bold(o.dryRun ? "DRY RUN — nothing will be written" : "squeeze") + c.dim(`  ${where}`) + c.dim(`  quality: ${o.quality}${o.fast ? ", fast" : ""}`) + (o.maxResolution ? c.dim(`  max resolution: ${describeBox(o.maxResolution)}`) : ""));
    if (images.length) {
      const m = o.imageQuality === undefined ? "lossless" : `lossy q${o.imageQuality}`;
      log(`  ${images.length} image(s), ${fmtBytes(sum(images))}  ${c.dim(`[${m}${o.strip.size ? `, strip ${[...o.strip].join("+")}` : ", metadata kept"}]`)}`);
    }
    if (videos.length) {
      log(`  ${videos.length} video(s), ${fmtBytes(sum(videos))}  ${c.dim(`[${o.encoder ?? "libsvtav1"}, ${o.crf !== undefined ? `fixed CRF ${o.crf}, no search` : `${describeQuality(o, metric)}, ≤${o.maxEncodedPercent}% size`}]`)}`);
    }
    if (others.length) log(`  ${others.length} other file(s), ${fmtBytes(sum(others))}  ${c.dim("[copied as-is]")}`);
    log();
  }

  // plan targets, catching two inputs that would land on the same file
  const seen = new Map<string, string>();
  const jobs = entries.map((e) => {
    const target = targetFor(e, o, multiRoot);
    const clash = seen.get(target);
    if (!clash) seen.set(target, e.path);
    return { e, target, clash };
  });

  const total = images.length + videos.length;
  let counter = 0;
  const results: Outcome[] = [];
  const finish = (r: Outcome) => {
    results.push(r);
    printOutcome(r, ++counter, total, o);
    return r;
  };
  const mirrorTarget = (e: Entry) => targetFor({ ...e, kind: "other" }, o, multiRoot);

  const runMedia = async (j: (typeof jobs)[number]): Promise<Outcome> => {
    const { e, target, clash } = j;
    const base = { entry: e, target, before: e.size, after: e.size };
    if (clash) return finish({ ...base, status: "skipped", note: `same output as ${rel(clash)}` });

    const command = e.kind === "image"
      ? caesiumCommand(o, e.path, "<tmp>")
      : abav1Command(o, metric, { input: e.path, output: "<tmp>/out" + target.slice(target.lastIndexOf(".")), tempDir: "<tmp>" });
    if (o.dryRun) return finish({ ...base, status: "planned", command });

    try {
      const label = `${c.dim("[")}${counter + 1}/${total}${c.dim("]")} ${rel(e.path)}`;
      const r = e.kind === "image"
        ? await compressImage(e, o, target)
        : await compressVideo(e, o, target, metric, label);
      if (r.status === "skipped" && o.strip.size && !r.note?.startsWith("output exists")) {
        // the original still has the metadata the user asked to remove: don't mirror it into the output
        return finish({ ...r, note: `${r.note}; metadata NOT stripped${o.replace ? "" : ", not copied"}`, command });
      }
      // couldn't/shouldn't compress: keep the mirror complete with the original bytes
      if (r.status === "skipped" && o.copyOthers && !o.replace && !r.note?.startsWith("output exists")) {
        const cp = await copyThrough(e, o, mirrorTarget(e));
        if (cp.status === "copied") r.note += "; copied as-is";
      }
      return finish({ ...r, command });
    } catch (err) {
      return finish({ ...base, status: "error", note: (err as Error).message, command });
    } finally {
      clearStatusLine();
    }
  };

  const runOther = async (j: (typeof jobs)[number]): Promise<Outcome> => {
    const { e, target, clash } = j;
    const base = { entry: e, target, before: e.size, after: e.size };
    let r: Outcome;
    if (clash) r = { ...base, status: "skipped", note: `same output as ${rel(clash)}` };
    else if (o.dryRun) r = { ...base, status: "planned" };
    else r = await copyThrough(e, o, target).catch((err) => ({ ...base, status: "error" as const, note: (err as Error).message }));
    results.push(r);
    if (!o.json && (o.verbose || r.status === "error")) {
      log(`${r.status === "error" ? c.red("✖") : c.dim("→")} ${rel(e.path)}  ${c.dim(r.status === "planned" ? `would copy to ${rel(target)}` : r.note ?? "copied as-is")}`);
    }
    return r;
  };

  await pool(jobs.filter((j) => j.e.kind === "image"), o.jobs, runMedia);
  await pool(jobs.filter((j) => j.e.kind === "video"), o.videoJobs, runMedia);
  await pool(jobs.filter((j) => j.e.kind === "other"), o.jobs, runOther);
  clearStatusLine();

  return report(o, results);
}

function report(o: Options, results: Outcome[]): number {
  const count = (s: Outcome["status"]) => results.filter((r) => r.status === s).length;
  const done = results.filter((r) => r.status === "done");
  const before = done.reduce((a, r) => a + r.before, 0);
  const after = done.reduce((a, r) => a + r.after, 0);
  const errors = count("error");
  const media = results.filter((r) => r.entry.kind !== "other");
  const copied = results.filter((r) => r.status === "copied" || (r.entry.kind === "other" && r.status === "planned") || r.note?.endsWith("copied as-is")).length;

  if (o.json) {
    log(JSON.stringify({
      dryRun: o.dryRun,
      files: results.map((r) => ({
        path: r.entry.path, kind: r.entry.kind, status: r.status, target: r.target,
        before: r.before, after: r.after, note: r.note, command: o.dryRun ? r.command : undefined,
      })),
      summary: {
        total: results.length, compressed: done.length, skipped: media.filter((r) => r.status === "skipped").length, copied, errors, planned: media.filter((r) => r.status === "planned").length,
        before, after, saved: before - after,
      },
    }, null, 2));
    return errors ? 1 : 0;
  }

  log();
  if (o.dryRun) {
    const pm = media.filter((r) => r.status === "planned");
    const total = pm.reduce((a, r) => a + r.before, 0);
    log(c.bold(`Would compress ${pm.length} file(s), ${fmtBytes(total)} total`) + (copied ? `, copy ${copied} other file(s) as-is.` : ".") +
      c.dim("  Savings can't be predicted without running; remove --dry-run to compress."));
  } else {
    const line = `${done.length} compressed, ${media.filter((r) => r.status === "skipped").length} kept as-is, ${copied} copied unchanged, ${errors} failed`;
    log(c.bold("Done: ") + line);
    if (done.length) log(`Saved ${c.green(fmtBytes(before - after))}  (${fmtBytes(before)} → ${fmtBytes(after)}, ${c.green(fmtPct(before, after))})`);
  }
  return errors ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    clearStatusLine();
    logErr(c.red(`error: ${(err as Error).message}`));
    process.exit(2);
  },
);
