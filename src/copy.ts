import { copyFile, mkdir, stat, utimes } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entry, Options, Outcome } from "./types.ts";

/** Copy `e` to `target` unchanged (keeps mtime). Skips an existing target unless --overwrite. */
export async function copyThrough(e: Entry, o: Options, target: string): Promise<Outcome> {
  const base: Outcome = { entry: e, status: "copied", target, before: e.size, after: e.size };
  if (!o.overwrite && (await stat(target).then(() => true, () => false))) {
    return { ...base, status: "skipped", note: "output exists" };
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(e.path, target);
  await utimes(target, new Date(), new Date(e.mtimeMs)).catch(() => {});
  return base;
}
