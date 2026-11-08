import type { Command, Option } from "commander";

export const SHELLS = ["bash", "zsh", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

const PROG = "squeeze";

/** Options that take a directory rather than a free-form value. */
const DIR_OPTS = new Set(["out"]);
/** Options that may be given several times. */
const REPEATABLE = new Set(["exclude"]);

interface Flag {
  short?: string; // "-n"
  long?: string; // "--dry-run"
  desc: string;
  takesValue: boolean;
  valueName: string;
  choices?: string[];
  dir: boolean;
  repeatable: boolean;
}

function collect(program: Command): Flag[] {
  const flags: Flag[] = program.options
    .filter((o: Option) => !o.hidden)
    .map((o: Option) => ({
      short: o.short,
      long: o.long,
      desc: o.description.replace(/\s+/g, " ").trim(),
      takesValue: !!(o.required || o.optional),
      valueName: (o.flags.match(/<([^>]+)>/)?.[1] ?? "value").replace(/[^\w-]/g, ""),
      choices: o.argChoices ? [...o.argChoices] : undefined,
      dir: DIR_OPTS.has(o.attributeName()),
      repeatable: REPEATABLE.has(o.attributeName()),
    }));
  flags.push({ short: "-h", long: "--help", desc: "display help", takesValue: false, valueName: "", dir: false, repeatable: false });
  return flags;
}

const words = (f: Flag) => [f.short, f.long].filter(Boolean) as string[];

// ---------- bash ----------

function bash(flags: Flag[]): string {
  const all = flags.flatMap(words).join(" ");
  const cases = flags
    .filter((f) => f.takesValue)
    .map((f) => {
      const pat = words(f).join("|");
      if (f.choices) return `    ${pat}) COMPREPLY=( $(compgen -W "${f.choices.join(" ")}" -- "$cur") ); return ;;`;
      if (f.dir) return `    ${pat}) COMPREPLY=( $(compgen -d -- "$cur") ); compopt -o filenames 2>/dev/null; return ;;`;
      return `    ${pat}) return ;;  # free-form value`;
    })
    .join("\n");
  return `# bash completion for ${PROG}  —  source this file, or:
#   ${PROG} --completion bash > ~/.local/share/bash-completion/completions/${PROG}
_${PROG}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}"
  COMPREPLY=()
  case "$prev" in
${cases}
  esac
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "${all}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -f -- "$cur") )
    compopt -o filenames 2>/dev/null
  fi
}
complete -F _${PROG} ${PROG}
`;
}

// ---------- zsh ----------

const zq = (s: string) => s.replace(/'/g, `'\\''`).replace(/([[\]])/g, "\\$1").replace(/:/g, "\\:");

function zsh(flags: Flag[]): string {
  const lines = flags.map((f) => {
    const star = f.repeatable ? "*" : "";
    const qstar = f.repeatable ? "'*'" : "";
    const d = zq(f.desc);
    const value = !f.takesValue
      ? ""
      : f.choices
        ? `:${f.valueName}:(${f.choices.join(" ")})`
        : f.dir
          ? `:${f.valueName}:_files -/`
          : `:${f.valueName}: `;
    const excl = !f.repeatable && f.short && f.long ? `'(${f.short} ${f.long})'` : "";
    if (f.short && f.long) {
      const sh = f.takesValue ? `${f.short}+` : f.short;
      const lg = f.takesValue ? `${f.long}=` : f.long;
      return `    ${qstar}${excl}{${sh},${lg}}'[${d}]${value}'`;
    }
    const name = f.long ?? f.short!;
    return `    '${star}${name}${f.takesValue && f.long ? "=" : ""}[${d}]${value}'`;
  });
  return `#compdef ${PROG}
# zsh completion for ${PROG}  —  put this file on your $fpath as "_${PROG}", e.g.:
#   ${PROG} --completion zsh > ~/.zfunc/_${PROG}     # with  fpath+=~/.zfunc ; autoload -U compinit && compinit
_arguments -s -S \\
${lines.join(" \\\n")} \\
    '*:file or directory:_files'
`;
}

// ---------- fish ----------

const fq = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

function fish(flags: Flag[]): string {
  const lines = flags.map((f) => {
    let l = `complete -c ${PROG}`;
    if (f.short) l += ` -s ${f.short.slice(1)}`;
    if (f.long) l += ` -l ${f.long.slice(2)}`;
    if (f.takesValue) {
      if (f.choices) l += ` -x -a '${f.choices.join(" ")}'`;
      else if (f.dir) l += ` -r -a '(__fish_complete_directories)'`;
      else l += ` -x`;
    }
    return `${l} -d '${fq(f.desc)}'`;
  });
  return `# fish completion for ${PROG}  —  save as ~/.config/fish/completions/${PROG}.fish:
#   ${PROG} --completion fish > ~/.config/fish/completions/${PROG}.fish
${lines.join("\n")}
`;
}

export function generateCompletion(shell: Shell, program: Command): string {
  const flags = collect(program);
  return shell === "bash" ? bash(flags) : shell === "zsh" ? zsh(flags) : fish(flags);
}
