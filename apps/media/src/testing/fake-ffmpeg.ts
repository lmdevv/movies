/**
 * Stand-ins for `FFMPEG_PATH` and `FFPROBE_PATH` for tests that need the tools to misbehave in
 * ways real hardware and storage do: a Quick Sync run that dies partway through (a GPU hang, a
 * driver reset), an encoder that is slow to write its first segment, or a keyframe scan of a file
 * on a slow share. It is a small Node script that runs the real ffmpeg; nothing in the
 * service is replaced, only the process it starts.
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How the stand-in misbehaves. */
export interface FakeFfmpegBehavior {
  /**
   * Quick Sync runs encode in software for this many seconds of output, then exit with status 1,
   * as a run that fails after its first segments would.
   */
  readonly qsvFailsAfterSeconds?: number;
  /** HLS runs wait this long before starting, as a slow disk or a busy encoder would. */
  readonly hlsDelayMs?: number;
  /** HLS runs exit with status 1 before writing anything, as a broken source or codec would. */
  readonly hlsFailsAtStart?: boolean;
  /** HLS runs that seek to this many seconds or later fail at start, as a damaged part would. */
  readonly hlsFailsFromSeconds?: number;
  /** HLS runs from the start of the file write only this many seconds, then finish. */
  readonly hlsFromStartSeconds?: number;
}

/** Arguments of a Quick Sync run that have no software equivalent, each followed by a value. */
const QSV_ONLY = [
  "-init_hw_device",
  "-filter_hw_device",
  "-hwaccel",
  "-hwaccel_output_format",
  "-forced_idr",
];

const script = (realFfmpeg: string, behavior: FakeFfmpegBehavior): string => `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const behavior = ${JSON.stringify(behavior)};
const qsvOnly = new Set(${JSON.stringify(QSV_ONLY)});
let args = process.argv.slice(2);
const hls = args.includes("hls");
const qsv = args.includes("h264_qsv") && behavior.qsvFailsAfterSeconds !== undefined;

if (hls && behavior.hlsDelayMs !== undefined) {
  await new Promise((resolve) => setTimeout(resolve, behavior.hlsDelayMs));
}

const seekTo = Number(args[args.indexOf("-ss") + 1] ?? 0);
const damaged =
  behavior.hlsFailsFromSeconds !== undefined &&
  args.includes("-ss") &&
  seekTo >= behavior.hlsFailsFromSeconds;

if (hls && !args.includes("-ss") && behavior.hlsFromStartSeconds !== undefined) {
  const format = args.indexOf("hls") - 1;

  args = [...args.slice(0, format), "-t", String(behavior.hlsFromStartSeconds), ...args.slice(format)];
}

if (hls && (behavior.hlsFailsAtStart === true || damaged)) {
  console.error("Conversion failed!");
  process.exit(1);
}

if (qsv) {
  const software = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (qsvOnly.has(arg)) {
      index += 1;
    } else if (arg === "-vf") {
      const size = /w=(\\d+):h=(\\d+)/.exec(args[index + 1] ?? "");
      software.push("-vf", \`scale=\${size?.[1] ?? -2}:\${size?.[2] ?? -2},format=yuv420p\`);
      index += 1;
    } else if (arg === "h264_qsv") {
      software.push("libx264");
    } else if (arg === "-f" && args[index + 1] === "hls") {
      software.push("-t", String(behavior.qsvFailsAfterSeconds), arg);
    } else {
      software.push(arg);
    }
  }

  args = software;
}

const result = spawnSync(${JSON.stringify(realFfmpeg)}, args, { stdio: "inherit" });

process.exit(qsv ? 1 : (result.status ?? 1));
`;

/** Writes the stand-in into a new temporary folder and returns its path, for `FFMPEG_PATH`. */
export const writeFakeFfmpeg = async (behavior: FakeFfmpegBehavior): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "movies-fake-ffmpeg-")), "ffmpeg.mjs");

  await writeFile(file, script(process.env["FFMPEG_PATH"] ?? "ffmpeg", behavior));
  await chmod(file, 0o755);

  return file;
};

const ffprobeScript = (
  realFfprobe: string,
  packetScanDelayMs: number,
): string => `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("packet=pts_time,flags")) {
  await new Promise((resolve) => setTimeout(resolve, ${String(packetScanDelayMs)}));
}

const result = spawnSync(${JSON.stringify(realFfprobe)}, args, { stdio: "inherit" });

process.exit(result.status ?? 1);
`;

/**
 * Writes a stand-in `FFPROBE_PATH` whose packet scans (keyframe indexing) take
 * `packetScanDelayMs` longer, as on a large file over a slow share; returns its path.
 */
export const writeSlowFfprobe = async (packetScanDelayMs: number): Promise<string> => {
  const file = join(await mkdtemp(join(tmpdir(), "movies-fake-ffprobe-")), "ffprobe.mjs");

  await writeFile(file, ffprobeScript(process.env["FFPROBE_PATH"] ?? "ffprobe", packetScanDelayMs));
  await chmod(file, 0o755);

  return file;
};
