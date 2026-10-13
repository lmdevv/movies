import { describe, expect, it } from "vitest";

import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import type { HlsCommand } from "./transcode-command.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

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
  subtitleCodec: "",
  segmentStarts: [1.4, 3.4],
  outputDirectory: "/tmp/stream/1",
  qsvDevice: "/dev/dri/renderD128",
  vaapiDevice: "/dev/dri/renderD129",
});

/** The audio arguments: from `-map 0:1` up to the metadata options. */
const audioPart = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.slice(args.indexOf("0:1") - 1, args.indexOf("-map_metadata"));

/** An encode to 1080p at 8 Mb/s on `encoder`. */
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

/** A software encode burning in DVD subtitle stream 3, from `from` seconds. */
const dvd = (from: number) =>
  hlsCommandArgs({
    ...command(AudioPlan.Copy({ index: 1 }), "aac"),
    from,
    subtitleCodec: "dvd_subtitle",
    video: encode("software", { burnSubtitle: 3 }),
  });

/** The argument after the first `flag`. */
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
      "aac_adtstoasc",
    ]);
  });

  it("copies other codecs without the AAC filter, and encodes AAC without it", () => {
    expect(audioPart(hlsCommandArgs(command(AudioPlan.Copy({ index: 1 }), "ac3")))).toStrictEqual([
      "-map",
      "0:1",
      "-c:a",
      "copy",
    ]);
    expect(hlsCommandArgs(command(AudioPlan.Aac({ index: 1 }), "ac3"))).not.toContain(
      "aac_adtstoasc",
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

  it("burns an image subtitle in on the CPU, scaled to the picture, before the GPU takes over", () => {
    const software = hlsCommandArgs({
      ...command(AudioPlan.Copy({ index: 1 }), "aac"),
      video: encode("software", { burnSubtitle: 3 }),
    });

    expect(software).not.toContain("-vf");
    expect(after(software, "-filter_complex")).toBe(
      [
        "[0:0]scale=1920:1080:flags=bicubic[base]",
        "[0:3][base]scale2ref=w=rw:h=rh[subtitle][picture]",
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

    // A burned-in subtitle needs frames in memory, so the GPU neither decodes nor gets them early.
    expect(vaapi).not.toContain("-hwaccel");
    expect(after(vaapi, "-filter_complex")).toBe(
      [
        "[0:0]null[base]",
        "[0:3][base]scale2ref=w=rw:h=rh[subtitle][picture]",
        "[picture][subtitle]overlay=eof_action=pass:repeatlast=0,format=p010le,hwupload,tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709,scale_vaapi=w=1920:h=1080:format=nv12[video]",
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
      expect.stringContaining("[0:3][base]scale2ref"),
    ]);

    // From 61.4 s: the picture from there, the subtitle from 30 s before it.
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
    expect(after(seeked, "-filter_complex")).toContain("[1:3][base]scale2ref");
  });
});
