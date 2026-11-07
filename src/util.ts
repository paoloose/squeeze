import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// ---------- formatting ----------

const useColor = !process.env.NO_COLOR && process.stderr.isTTY && process.stdout.isTTY;
const paint = (open: number, close: number) => (s: string) =>
  useColor ? `\x1b[${open}m${s}\x1b[${close}m` : s;
export const c = {
  bold: paint(1, 22),
  dim: paint(2, 22),
  red: paint(31, 39),
  green: paint(32, 39),
  yellow: paint(33, 39),
  cyan: paint(36, 39),
};

export function fmtBytes(n: number): string {
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${sign}${i === 0 ? n : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function fmtPct(before: number, after: number): string {
  if (before === 0) return "0%";
  const p = ((after - before) / before) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(1)}%`;
}

/** Whitespace split that understands simple "double" and 'single' quotes. */
export function splitArgs(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

/** Print a command roughly as a shell would show it. */
export function shellQuote(cmd: string[]): string {
  return cmd.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

// ---------- live status line + logging ----------

let statusText = "";
let tty = !!process.stderr.isTTY;
export function setStatusEnabled(on: boolean) {
  tty = on && !!process.stderr.isTTY;
}

function clearStatus() {
  if (tty && statusText) process.stderr.write("\r\x1b[K");
}
export function setStatus(text: string) {
  if (!tty) return;
  const cols = process.stderr.columns || 100;
  statusText = text.length > cols - 1 ? text.slice(0, cols - 2) + "…" : text;
  process.stderr.write("\r\x1b[K" + c.dim(statusText));
}
export function clearStatusLine() {
  clearStatus();
  statusText = "";
}
/** Write a line to stdout without being clobbered by the status line. */
export function log(line = "") {
  clearStatus();
  process.stdout.write(line + "\n");
  if (tty && statusText) process.stderr.write(c.dim(statusText));
}
export function logErr(line: string) {
  clearStatus();
  process.stderr.write(line + "\n");
}

// ---------- subprocesses & temp dirs ----------

const procs = new Set<Bun.Subprocess>();
const tmpDirs = new Set<string>();

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string[],
  opts: { onStderrLine?: (line: string) => void } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  procs.add(proc);
  try {
    const readStderr = async () => {
      let all = "";
      let pending = "";
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        all += text;
        if (opts.onStderrLine) {
          pending += text;
          const parts = pending.split(/[\r\n]+/);
          pending = parts.pop() ?? "";
          for (const p of parts) if (p.trim()) opts.onStderrLine(p);
          if (pending.trim()) opts.onStderrLine(pending);
        }
      }
      return all;
    };
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), readStderr()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  } finally {
    procs.delete(proc);
  }
}

export async function makeTmp(dir: string): Promise<string> {
  const d = await mkdtemp(join(dir, ".squeeze-"));
  tmpDirs.add(d);
  return d;
}
export async function dropTmp(dir: string) {
  tmpDirs.delete(dir);
  await rm(dir, { recursive: true, force: true });
}

/** Kill children and delete temp dirs; used on Ctrl-C / SIGTERM. */
export function installSignalHandlers() {
  const bail = (code: number) => async () => {
    clearStatusLine();
    for (const p of procs) p.kill();
    await Promise.all([...tmpDirs].map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
    process.stderr.write("\naborted; originals are untouched, temp files removed.\n");
    process.exit(code);
  };
  process.on("SIGINT", bail(130));
  process.on("SIGTERM", bail(143));
}

// ---------- concurrency ----------

export async function pool<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return results;
}
