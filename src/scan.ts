import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import type { Entry, Kind, Options } from "./types.ts";

export const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".tif", ".tiff"]);
export const VIDEO_EXTS = new Set([
  ".mp4", ".mkv", ".mov", ".m4v", ".webm", ".avi", ".wmv", ".flv", ".mts", ".m2ts", ".mpg", ".mpeg",
]);

const DEFAULT_SKIP_DIRS = new Set(["node_modules"]);

export function kindOf(file: string): Kind | undefined {
  const ext = extname(file).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (VIDEO_EXTS.has(ext)) return "video";
  return undefined;
}

/** Directories this tool writes into; never scan them again. */
export function isOwnOutput(name: string) {
  return name.endsWith(".squeezed") || name.startsWith(".squeeze-");
}

export async function scan(inputs: string[], o: Options, skipAbs: string[] = []): Promise<Entry[]> {
  const exclude = o.exclude.map((g) => new Bun.Glob(g));
  const excluded = (rel: string) => exclude.some((g) => g.match(rel) || g.match(basename(rel)));
  const entries = new Map<string, Entry>();

  const want = (k: Kind) => !o.only || (o.only === "images") === (k === "image");

  async function walk(dir: string, root: string) {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`cannot read ${dir}: ${(e as Error).message}`);
    }
    for (const it of items) {
      const abs = join(dir, it.name);
      const rel = relative(root, abs);
      if (it.isSymbolicLink()) continue;
      if (!o.hidden && it.name.startsWith(".")) continue;
      if (isOwnOutput(it.name) || skipAbs.includes(abs) || excluded(rel)) continue;
      if (it.isDirectory()) {
        if (DEFAULT_SKIP_DIRS.has(it.name) || !o.recursive) continue;
        await walk(abs, root);
      } else if (it.isFile()) {
        const kind = kindOf(it.name);
        const st = await stat(abs);
        if (kind && want(kind) && st.size > 0) {
          entries.set(abs, { path: abs, root, rootIsFile: false, kind, size: st.size, mtimeMs: st.mtimeMs });
        } else if (o.copyOthers && !o.replace) {
          // unknown type, filtered out by --only, or empty: mirror it untouched
          entries.set(abs, { path: abs, root, rootIsFile: false, kind: "other", size: st.size, mtimeMs: st.mtimeMs });
        }
      }
    }
  }

  for (const input of inputs) {
    const abs = resolve(input);
    let st;
    try {
      st = await stat(abs);
    } catch {
      throw new Error(`no such file or directory: ${input}`);
    }
    if (st.isDirectory()) {
      await walk(abs, abs);
    } else {
      const kind = kindOf(abs);
      if (!kind) throw new Error(`unsupported file type: ${input}`);
      if (!want(kind)) continue;
      entries.set(abs, { path: abs, root: dirname(abs), rootIsFile: true, kind, size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}
