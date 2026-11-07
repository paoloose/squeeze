/**
 * --max-resolution: never keep more pixels than this. Orientation-agnostic: the limit is a box,
 * and an image/video is fitted by comparing its LONG edge to the box's long edge and its SHORT
 * edge to the box's short edge. So "1080p" caps a 1920x1080 landscape clip and a 1080x1920
 * portrait clip identically, and a 3840x2160 portrait phone video becomes 1080x1920.
 * Never upscales; aspect ratio is kept.
 */
export interface Box {
  long: number;
  short: number; // Infinity => only the long edge is limited
}

const NAMED: Record<string, [number, number]> = {
  "480p": [854, 480],
  "720p": [1280, 720], hd: [1280, 720],
  "1080p": [1920, 1080], fhd: [1920, 1080],
  "1440p": [2560, 1440], "2k": [2560, 1440], qhd: [2560, 1440],
  "2160p": [3840, 2160], "4k": [3840, 2160], uhd: [3840, 2160],
  "4320p": [7680, 4320], "8k": [7680, 4320],
};

export const RESOLUTION_HELP =
  "480p 720p 1080p 2k(=1440p) 4k 8k, a box like 1280x720, or one number = max long edge in px";

/** Accepts: a name (case-insensitive), "WxH" (either order), or a single number (long edge). */
export function parseResolution(input: string): Box {
  const s = input.trim().toLowerCase();
  const named = NAMED[s];
  if (named) return { long: named[0], short: named[1] };

  const wh = s.match(/^(\d+)\s*[x×]\s*(\d+)$/);
  if (wh) {
    const a = Number(wh[1]), b = Number(wh[2]);
    if (a < 16 || b < 16) throw new Error("resolution is too small");
    return { long: Math.max(a, b), short: Math.min(a, b) };
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 16) throw new Error("resolution is too small");
    return { long: n, short: Infinity };
  }
  throw new Error(`unrecognised resolution "${input}". Use ${RESOLUTION_HELP}`);
}

export const describeBox = (b: Box) => (b.short === Infinity ? `long edge ≤ ${b.long}px` : `≤ ${b.long}×${b.short} (any orientation)`);

/**
 * Display-oriented size (w,h) -> fitted size, or undefined if it already fits.
 * `even` rounds down to even numbers (needed by yuv420 video encoders).
 */
export function fit(w: number, h: number, box: Box, even = false): { w: number; h: number } | undefined {
  const long = Math.max(w, h), short = Math.min(w, h);
  const scale = Math.min(1, box.long / long, box.short / short);
  if (scale >= 1) return undefined;
  const round = (n: number) => {
    const v = Math.max(2, Math.floor(n * scale));
    return even ? v - (v % 2) : v;
  };
  return { w: round(w), h: round(h) };
}
