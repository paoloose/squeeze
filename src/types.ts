export type Kind = "image" | "video" | "other";
export type Metric = "vmaf" | "xpsnr";

import type { Level } from "./quality.ts";
import type { StripKeyword } from "./metadata.ts";
import type { Box } from "./resolution.ts";

export interface Options {
  quality: Level;
  explicitVmaf: boolean;
  explicitXpsnr: boolean;
  fast: boolean; // no quality search for video, cheaper settings and fewer checks for images
  crf?: number; // fixed CRF for video (implied by --fast)
  maxResolution?: Box; // downscale anything larger (images and video)
  // behaviour
  dryRun: boolean;
  replace: boolean;
  out?: string;
  overwrite: boolean;
  recursive: boolean;
  hidden: boolean;
  copyOthers: boolean; // output-dir mode: copy files we cannot/should not compress as-is
  only?: "images" | "videos";
  exclude: string[];
  minSavings: number; // percent; results saving less than this are discarded
  jobs: number;
  videoJobs: number;
  verbose: boolean;
  quiet: boolean;
  json: boolean;

  // images (caesiumclt)
  imageQuality?: number; // undefined => lossless
  strip: Set<StripKeyword>; // --strip-metadata keywords; empty = keep everything
  pngLevel: number;
  zopfli: boolean;
  caesiumArgs: string[];

  // videos (ab-av1)
  metric: Metric | "auto";
  minVmaf: number;
  minXpsnr: number;
  encoder?: string;
  preset?: string;
  maxEncodedPercent: number;
  audioCodec?: string;
  verify: boolean;
  includeAv1: boolean;
  abAv1Args: string[];
}

export interface Entry {
  path: string; // absolute
  root: string; // absolute dir (or the file's dir for a file input)
  rootIsFile: boolean;
  kind: Kind;
  size: number;
  mtimeMs: number;
}

export type Status = "done" | "skipped" | "error" | "planned" | "copied";

export interface Outcome {
  entry: Entry;
  status: Status;
  target?: string;
  before: number;
  after: number; // == before unless status is "done"
  note?: string;
  command?: string[];
}
