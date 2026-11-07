/**
 * One easy knob (--quality) that maps to the metric-specific settings underneath.
 * Videos use whichever metric this ffmpeg supports (VMAF if built with libvmaf, else XPSNR);
 * the level means the same thing either way. Expert flags (--min-vmaf, --min-xpsnr,
 * --image-quality) still override individual values.
 */
export const LEVELS = ["max", "high", "medium", "low"] as const;
export type Level = (typeof LEVELS)[number];

export interface LevelSpec {
  vmaf: number;
  xpsnr: number; // dB
  image?: number; // caesium quality 0-100; undefined = lossless
  crf: number; // SVT-AV1 CRF used by --fast (no search, so it must be safe for hard content)
  blurb: string;
}

/*
 * XPSNR steps calibrated with `ab-av1 crf-search` on real Pixel footage (2026-11-07);
 * resulting size as % of the original HEVC:
 *              4K 65 Mbit/s (detailed)   1080p (easier content)
 *   41 dB      impossible (kept as-is)   35%
 *   40 dB      85%                       ~25%
 *   38.5 dB    52%                       17%
 *   37 dB      18%                       -
 *   34 dB      0% (crf 64, unusable)     -
 * XPSNR is steep: ~1.5 dB moves the 4K clip from 85% to 52%, so the levels sit close together.
 * --fast skips the search and uses one CRF per level, chosen so the *harder* clip still meets the
 * target: 4K detailed needs crf <=28.75 for 40 dB, <=32 for 38.5 dB, <=37 for 37 dB (41 dB was only
 * reachable at crf ~22 and 152% size). Easier clips then end up better than needed, and bigger.
 * VMAF values are common rules of thumb, not calibrated here (no libvmaf on the test machine).
 */
export const LEVEL_SPECS: Record<Level, LevelSpec> = {
  max: { vmaf: 97, xpsnr: 41, crf: 24, image: undefined, blurb: "safest; detailed videos often stay as-is, images lossless" },
  high: { vmaf: 95, xpsnr: 40, crf: 28, image: undefined, blurb: "visually transparent videos, lossless images (default)" },
  medium: { vmaf: 93, xpsnr: 38.5, crf: 32, image: 90, blurb: "about half the size on detailed 4K; images become lossy" },
  low: { vmaf: 91, xpsnr: 37, crf: 37, image: 80, blurb: "smallest; check a few results by eye; images lossy" },
};

export const levelHelp = () =>
  LEVELS.map((l) => `${l.padEnd(6)} ${LEVEL_SPECS[l].blurb}`).join("\n");
