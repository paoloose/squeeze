# squeeze

Wraps [`caesiumclt`](https://github.com/Lymphatus/caesium-clt) (images) and [`ab-av1`](https://github.com/alexheretic/ab-av1) (videos) to shrink a file or a whole directory tree. Built with Bun + [commander](https://github.com/tj/commander.js).

```sh
bun install
bun link            # optional: puts `squeeze` on your PATH
squeeze --help
```

## Behaviour

| | default | tweak |
|---|---|---|
| Quality | `--quality max\|high\|medium\|low` (default `high`): one knob for both, works with either video metric | `--min-vmaf`, `--min-xpsnr`, `--image-quality N\|lossless` override single values |
| Images | **truly lossless** (JPEG/PNG re-optimisation), metadata kept | `--image-quality N` for lossy, `--png-level`, `--zopfli`, `--caesium-args` |
| Videos | AV1 at the smallest size meeting a perceptual target (VMAF ≥ 95, or XPSNR ≥ 40 dB if your ffmpeg lacks libvmaf; auto-detected). Video can't be bit-exact. | `--min-vmaf`, `--min-xpsnr`, `--metric`, `--preset`, `-e/--encoder`, `--max-encoded-percent`, `--acodec`, `--ab-av1-args` |
| Output | **non-destructive**: `<dir>.squeezed/` (or `<file>.squeezed.<ext>`) | `-o DIR`, `--replace` (in place, atomic), `--overwrite` |
| Other files | copied as-is into the output dir (also media that couldn't be shrunk) | `--no-copy-others` |

**Resolution cap**: `--max-resolution 1080p|2k|4k|8k|WxH|N` downscales anything bigger, images and video, any
orientation (the box is matched on long/short edges, so `1080p` turns a 4K portrait clip into 1080×1920). It never
upscales. `2k` means 2560×1440; use `2048x1080` for the cinema size. Resized JPEG/WebP use quality 90 (or the level's),
PNGs stay lossless. For Pixel photos the gain map and motion clip are kept and the EXIF size tags are updated.
For video the quality score measures the encode, not the downscale itself.

**`--strip-metadata <keywords>`** (off by default) removes embedded metadata from images and video. Keywords,
comma-separated and/or repeated: `gps` (location), `date` (capture dates, time-zone offsets, sub-seconds, video
`creation_time`), `camera` (make, model, serials, lens, MakerNote; video `com.android.*` tags), `software`
(firmware/editing software, encoder tags), `all` (everything above, plus every other video tag and all metadata of
non-JPEG images). Examples: `--strip-metadata gps` before sharing photos, `--strip-metadata gps,camera,software`.
- JPEG: the chosen EXIF tags are removed in place and their bytes zeroed, so the data is gone, not just hidden.
  Orientation, exposure and colour data are never touched. Pixel photos keep their gain map and motion clip.
- Non-JPEG images (PNG, WebP, ...): any keyword strips all metadata, since selective removal isn't supported there.
- Video: tags are removed in a stream-copy remux (no re-encode). Rotation is not metadata and is kept.
- **Known gap:** a Motion Photo's embedded video clip is kept byte-for-byte and still carries its own date and
  camera tags; the result line says so.
- If a file can't be rewritten (for example it was kept because compression gained nothing), it is **not** copied
  to the output, and its result line says "metadata NOT stripped". With `--replace` it stays as-is.
- The filesystem modified date is preserved (it isn't embedded metadata). Option values are required:
  `--strip-metadata all`, not a bare `--strip-metadata`.

**`--fast`**: videos get one encode at a fixed CRF per `--quality` level instead of a search (`--crf N` sets it
yourself); PNGs use level 1 instead of 3; the extra decode check on lossless photos is skipped (structural checks
stay). Measured on images: PNG 3× faster for ~6.5% larger files, JPEGs unchanged. A fixed CRF can't adapt to the
content, so video sizes vary more from clip to clip than with the search.

**Ultra HDR / Motion Photos (Pixel `.MP.jpg` etc.)**: a plain optimiser would silently drop the HDR gain map
and the motion clip appended after the JPEG. squeeze splits the file, losslessly re-encodes only the main image,
keeps every metadata segment and the appended gain map / video byte-for-byte, patches the MPF offsets, and verifies
the result (structure + identical decoded pixels). Files with trailing data it doesn't understand are left untouched.
Metadata is kept by default (see `--strip-metadata` below for what changes when you ask for it).

A result is only kept if it is smaller by at least `--min-savings` (default 2 %); otherwise the original stays.
`--only-images` / `--only-videos` (mutually exclusive) restrict what gets compressed; the rest is copied as-is.
Already-AV1 videos are skipped (`--include-av1`). Hidden files/dirs and `node_modules` are skipped (`--hidden`, `-x GLOB`).

`-n/--dry-run` lists what would be processed, where it'd go, and (with `-v`) the exact commands, writing nothing.
Running `squeeze` with no arguments prints help; pass `.` for the current directory.
`--json` gives a machine-readable report. Exit code: 0 ok, 1 some files failed, 2 bad usage.

Shell completions (generated from the CLI definition, so they stay in sync):
`squeeze --completion bash|zsh|fish` prints a script; see the header comment in each for where to put it.

```sh
squeeze .                            # current dir, lossless, output in ../<cwd>.squeezed
squeeze -n -v ~/Pictures             # preview
squeeze --replace photos/            # shrink in place
squeeze --only-videos --min-vmaf 97 --preset 6 clips/
```
