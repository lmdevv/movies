import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { parseFfprobeJson } from "./media-probe.ts";

/** The ffprobe stream fields these tests write. */
interface StreamJson {
  readonly index: number;
  readonly codec_type: string;
  readonly codec_name: string;
  readonly profile?: string;
  readonly level?: number;
  readonly pix_fmt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly color_transfer?: string;
  readonly side_data_list?: ReadonlyArray<{ readonly side_data_type: string }>;
  readonly channels?: number;
  readonly channel_layout?: string;
  readonly sample_rate?: string;
  readonly disposition?: {
    readonly default?: number;
    readonly forced?: number;
    readonly hearing_impaired?: number;
    readonly attached_pic?: number;
  };
  readonly tags?: { readonly language?: string; readonly title?: string };
}

const ffprobe = (streams: ReadonlyArray<StreamJson>, formatName = "matroska,webm") =>
  JSON.stringify({
    format: {
      format_name: formatName,
      duration: "5400.25",
      start_time: "0.000000",
      bit_rate: "8000000",
    },
    streams,
  });

describe("parseFfprobeJson", () => {
  it.effect("reads Dolby Vision, bitmap subtitles, and skips cover art", () =>
    Effect.gen(function* () {
      const probe = yield* parseFfprobeJson(
        ffprobe([
          {
            index: 0,
            codec_type: "video",
            codec_name: "mjpeg",
            width: 600,
            height: 900,
            disposition: { attached_pic: 1 },
          },
          {
            index: 1,
            codec_type: "video",
            codec_name: "hevc",
            profile: "Main 10",
            level: 153,
            pix_fmt: "yuv420p10le",
            width: 3840,
            height: 2160,
            avg_frame_rate: "24000/1001",
            color_transfer: "smpte2084",
            side_data_list: [{ side_data_type: "DOVI configuration record" }],
          },
          {
            index: 2,
            codec_type: "audio",
            codec_name: "truehd",
            channels: 8,
            channel_layout: "7.1",
            sample_rate: "48000",
            disposition: { default: 1 },
            tags: { language: "eng", title: "Atmos" },
          },
          {
            index: 3,
            codec_type: "subtitle",
            codec_name: "hdmv_pgs_subtitle",
            disposition: { forced: 1 },
            tags: { language: "eng" },
          },
          {
            index: 4,
            codec_type: "subtitle",
            codec_name: "ass",
            disposition: { hearing_impaired: 1 },
            tags: { language: "jpn" },
          },
        ]),
        "/library/Movie (2020)/Movie (2020).mkv",
      );

      assert.strictEqual(probe.container, "mkv");
      assert.strictEqual(probe.durationSeconds, 5400.25);
      assert.strictEqual(probe.bitRate, 8_000_000);
      assert.deepStrictEqual(
        [probe.video?.index, probe.video?.dynamicRange, probe.video?.bitDepth],
        [1, "dolby-vision", 10],
      );
      assert.approximately(probe.video?.frameRate ?? 0, 23.976, 0.001);
      assert.deepStrictEqual(probe.audio[0], {
        index: 2,
        codec: "truehd",
        profile: undefined,
        channels: 8,
        channelLayout: "7.1",
        sampleRate: 48_000,
        language: "eng",
        title: "Atmos",
        default: true,
      });
      assert.deepStrictEqual(
        probe.subtitles.map((track) => [
          track.codec,
          track.kind,
          track.forced,
          track.hearingImpaired,
        ]),
        [
          ["hdmv_pgs_subtitle", "bitmap", true, false],
          ["ass", "text", false, true],
        ],
      );
    }),
  );

  it.effect("tells MP4 from MOV and WebM from Matroska by extension, and HLG from PQ", () =>
    Effect.gen(function* () {
      const hlg = [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          color_transfer: "arib-std-b67",
        },
      ];

      const mov = yield* parseFfprobeJson(ffprobe(hlg, "mov,mp4,m4a,3gp,3g2,mj2"), "/a/clip.MOV");
      const webm = yield* parseFfprobeJson(ffprobe(hlg), "/a/clip.webm");

      assert.deepStrictEqual(
        [mov.container, webm.container, mov.video?.dynamicRange],
        ["mov", "webm", "hlg"],
      );
    }),
  );

  it.effect("fails with a typed error on output that is not a probe", () =>
    Effect.gen(function* () {
      const error = yield* parseFfprobeJson("{}", "/a/b.mkv").pipe(Effect.flip);

      assert.strictEqual(
        error.message,
        "Media probe invalid: ffprobe output did not describe a media file",
      );
    }),
  );
});
