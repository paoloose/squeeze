import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Entry, Options } from "./types.ts";

/** AV1 goes into mp4 or mkv; everything else is remuxed to mkv, which takes any stream. */
function videoExt(path: string): string {
  return extname(path).toLowerCase() === ".mp4" ? ".mp4" : ".mkv";
}

/**
 * Where the compressed result for `e` ends up.
 *  --replace : in place (video may change extension, e.g. .avi -> .mkv)
 *  --out DIR : mirrored under DIR (prefixed with the root's name when several inputs)
 *  default   : "<root>.squeezed/" next to a directory input, "<name>.squeezed.<ext>" for a file
 */
export function targetFor(e: Entry, o: Options, multiRoot: boolean): string {
  const fixExt = (p: string) => (e.kind === "video" ? p.slice(0, p.length - extname(p).length) + videoExt(e.path) : p);

  if (o.replace) return fixExt(e.path);

  if (o.out) {
    const out = resolve(o.out);
    const rel = e.rootIsFile ? basename(e.path) : relative(e.root, e.path);
    return fixExt(multiRoot && !e.rootIsFile ? join(out, basename(e.root), rel) : join(out, rel));
  }

  if (e.rootIsFile) {
    const ext = extname(e.path);
    const base = basename(e.path, ext);
    return fixExt(join(dirname(e.path), `${base}.squeezed${ext}`));
  }
  return fixExt(join(`${e.root}.squeezed`, relative(e.root, e.path)));
}
