import { describe, expect, it } from "vitest";

import { qsvProbeArgs } from "./hardware-acceleration.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import type { HlsCommand } from "./transcode-command.ts";
import { hlsCommandArgs, mp4CommandArgs } from "./transcode-command.ts";

const command = (audio: AudioPlan, audioCodec: string): HlsCommand => ({
  input: "/media/Film (2021).ts",
  sourceStart: 1.4,
  from: 1.4,
  videoIndex: 0,
  videoCodec: "h264",
  videoBitDepth: 8,
  video: VideoPlan.Copy(),
  audio,
  audioCodec,
  copiedAudioEnd: undefined,
  subtitleCodec: "",
  segmentStarts: [1.4, 3.4],
  previousStart: undefined,
  outputDirectory: "/tmp/stream/1",
  qsvDevice: "/dev/dri/renderD128",
  vaapiDevice: "/dev/dri/renderD129",
});

const audioPart = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.slice(args.indexOf("0:1") - 1, args.indexOf("-map_metadata"));

const encode = (
  encoder: "qsv" | "vaapi" | "software",
  options: { readonly toneMap?: boolean; readonly burnSubtitle?: number },
) =>
  VideoPlan.Encode({
    encoder,
    width: 1920,
    height: 1080,
    toneMap: options.toneMap ?? false,
    bitrate: 8_000_000,
    burnSubtitle: options.burnSubtitle,
  });

const dvd = (from: number) =>
  hlsCommandArgs({
    ...command(AudioPlan.Copy({ index: 1 }), "aac"),
    from,
    subtitleCodec: "dvd_subtitle",
    video: encode("software", { burnSubtitle: 3 }),
  });

const after = (args: ReadonlyArray<string>, flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

describe("hlsCommandArgs", () => {
  it("rewrites ADTS headers of copied AAC, which MPEG-TS files carry and MP4 refuses", () => {
    expect(audioPart(hlsCommandArgs(command(AudioPlan.Copy({ index: 1 }), "aac")))).toStrictEqual([
      "-map",
      "0:1",
      "-c:a",
      "copy",
      "-bsf:a",
      "aac_adtstoasc,noise=drop=lt(pts*tb\\,0.000000)",
    ]);
  });

  it("copies other codecs without the AAC filter, and encodes AAC without it", () => {
    expect(audioPart(hlsCommandArgs(command(AudioPlan.Copy({ index: 1 }), "ac3")))).toStrictEqual([
      "-map",
      "0:1",
      "-c:a",
      "copy",
      "-bsf:a",
      "noise=drop=lt(pts*tb\\,0.000000)",
    ]);
    expect(hlsCommandArgs(command(AudioPlan.Aac({ index: 1 }), "ac3"))).not.toContain(
      "aac_adtstoasc",
    );
  });

  it("opens Quick Sync on the configured render node, in the stream and in the probe", () => {
    // oneVPL builds ignore the path in `qsv=hw:<path>` and use the default GPU; the node must be
    // the child device, so a wrong one fails (and falls back) instead of encoding elsewhere.
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      qsvDevice: "/dev/dri/renderD130",
      video: encode("qsv", {}),
    });

    expect(after(args, "-init_hw_device")).toBe("qsv=hw,child_device=/dev/dri/renderD130");
    expect(after(qsvProbeArgs("/dev/dri/renderD130"), "-init_hw_device")).toBe(
      "qsv=hw,child_device=/dev/dri/renderD130",
    );
  });

  it("encodes on VA-API, decoding and tone-mapping on the GPU", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      videoBitDepth: 10,
      video: encode("vaapi", { toneMap: true }),
    });

    expect(args.slice(args.indexOf("-init_hw_device"), args.indexOf("-copyts"))).toStrictEqual([
      "-init_hw_device",
      "vaapi=va:/dev/dri/renderD129",
      "-filter_hw_device",
      "va",
      "-hwaccel",
      "vaapi",
      "-hwaccel_output_format",
      "vaapi",
      "-hwaccel_device",
      "va",
    ]);
    expect(after(args, "-vf")).toBe(
      "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,scale_vaapi=w=1920:h=1080:format=nv12",
    );
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-force_key_frames"))).toStrictEqual([
      "-c:v",
      "h264_vaapi",
      "-profile:v",
      "high",
      "-b:v",
      "8000000",
      "-maxrate",
      "8000000",
      "-bufsize",
      "16000000",
    ]);
    expect(after(args, "-force_key_frames")).toBe("1.400000,3.400000");
  });

  it("uploads frames the GPU cannot decode, in the source's bit depth", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "mpeg4",
      video: encode("vaapi", {}),
    });

    expect(args).not.toContain("-hwaccel");
    expect(after(args, "-vf")).toBe("format=nv12,hwupload,scale_vaapi=w=1920:h=1080:format=nv12");

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "mpeg4",
      videoBitDepth: 10,
      video: encode("qsv", {}),
    });

    expect(after(qsv, "-vf")).toBe(
      "format=p010le,hwupload=extra_hw_frames=64,vpp_qsv=w=1920:h=1080:format=nv12",
    );
  });

  it("tone-maps in software with zscale after scaling", () => {
    const args = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      video: encode("software", { toneMap: true }),
    });

    expect(after(args, "-vf")).toBe(
      "scale=1920:1080:flags=bicubic,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
    );
    expect(after(args, "-c:v")).toBe("libx264");
  });

  it("draws a burned-in subtitle on the SDR picture at the output size, on a GPU between transfers", () => {
    const software = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnSubtitle: 3 }),
    });

    expect(software).not.toContain("-vf");
    expect(after(software, "-filter_complex")).toBe(
      [
        "[0:0]scale=1920:1080:flags=bicubic[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=yuv420p[video]",
      ].join(";"),
    );
    expect(after(software, "-map")).toBe("[video]");

    const vaapi = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      videoCodec: "hevc",
      videoBitDepth: 10,
      video: encode("vaapi", { burnSubtitle: 3, toneMap: true }),
    });

    expect(vaapi).toContain("-hwaccel");
    expect(after(vaapi, "-filter_complex")).toBe(
      [
        "[0:0]tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,scale_vaapi=w=1920:h=1080:format=nv12,hwdownload,format=nv12[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload[video]",
      ].join(";"),
    );

    const qsv = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("qsv", { burnSubtitle: 3 }),
    });

    expect(after(qsv, "-filter_complex")).toBe(
      [
        "[0:0]vpp_qsv=w=1920:h=1080:format=nv12,hwdownload,format=nv12[picture]",
        "[0:3]scale=1920:1080[subtitle]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=nv12,hwupload=extra_hw_frames=64,format=qsv[video]",
      ].join(";"),
    );
  });

  it("reads a burned-in DVD subtitle on its canvas, a second time from earlier after a seek", () => {
    const fromStart = dvd(1.4);

    expect(fromStart.slice(fromStart.indexOf("-canvas_size"), fromStart.indexOf("-map"))).toEqual([
      "-canvas_size",
      "720x576",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-filter_complex",
      expect.stringContaining("[0:3]scale=1920:1080[subtitle]"),
    ]);

    const seeked = dvd(61.4);

    expect(seeked.slice(seeked.indexOf("-ss"), seeked.indexOf("-filter_complex"))).toStrictEqual([
      "-ss",
      "60.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
      "-canvas_size",
      "720x576",
      "-ss",
      "30.000000",
      "-copyts",
      "-i",
      "/media/Film (2021).ts",
    ]);
    expect(after(seeked, "-filter_complex")).toContain("[1:3]scale=1920:1080[subtitle]");
  });
});

const mp4 = (video: VideoPlan) =>
  mp4CommandArgs({
    input: "/media/Film (2021).mkv",
    videoIndex: 0,
    videoCodec: "hevc",
    videoBitDepth: 10,
    video,
    audio: AudioPlan.Aac({ index: 2 }),
    audioCodec: "dts",
    qsvDevice: "/dev/dri/renderD128",
    vaapiDevice: "/dev/dri/renderD129",
    output: "/tmp/downloads/f/key.mp4.part",
    progress: "/tmp/downloads/f/key.mp4.progress",
  });

describe("mp4CommandArgs", () => {
  it("copies the whole file into an MP4 with its index first, from the start", () => {
    const args = mp4(VideoPlan.Copy());

    expect(args).not.toContain("-ss");
    expect(args).not.toContain("-copyts");
    expect(args).not.toContain("-force_key_frames");
    expect(after(args, "-tag:v")).toBe("hvc1");
    expect(after(args, "-movflags")).toBe("+faststart");
    expect(after(args, "-progress")).toBe("/tmp/downloads/f/key.mp4.progress");
    expect(args.slice(-4)).toStrictEqual(["-f", "mp4", "-y", "/tmp/downloads/f/key.mp4.part"]);
  });

  it("encodes in software without a segment plan", () => {
    const args = mp4(encode("software", {}));

    expect(after(args, "-c:v")).toBe("libx264");
    expect(after(args, "-vf")).toBe("scale=1920:1080:flags=bicubic,format=yuv420p");
    expect(args).not.toContain("-force_key_frames");
    expect(after(args, "-c:a")).toBe("aac");
  });
});
