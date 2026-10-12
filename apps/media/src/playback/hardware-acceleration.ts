/**
 * Whether Intel Quick Sync can be used for video transcodes. In `auto` mode the first query runs
 * a one-second QSV test encode and remembers the answer; a QSV failure during playback marks it
 * unavailable for the rest of the process so later sessions go straight to software.
 */
import { Context, Effect, Layer, Ref } from "effect";

import * as MediaConfig from "../media-config.ts";
import * as MediaTools from "../media/media-tools.ts";

/** Hardware transcoding availability. */
export interface Interface {
  readonly qsvAvailable: Effect.Effect<boolean>;
  /** Stops offering QSV after it failed at runtime. */
  readonly markQsvUnavailable: (reason: string) => Effect.Effect<void>;
  readonly qsvDevice: string;
}

/** Hardware transcoding availability. */
export class Service extends Context.Service<Service, Interface>()(
  "@movies/media/HardwareAcceleration",
) {}

/** Arguments of the QSV test encode: one second of generated video through `h264_qsv`. */
export const qsvProbeArgs = (device: string): ReadonlyArray<string> => [
  "-hide_banner",
  "-nostdin",
  "-v",
  "error",
  "-init_hw_device",
  `qsv=hw:${device}`,
  "-filter_hw_device",
  "hw",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=320x240:rate=10:duration=1",
  "-vf",
  "hwupload=extra_hw_frames=16,format=qsv",
  "-c:v",
  "h264_qsv",
  "-f",
  "null",
  "-",
];

/** Builds the availability check from the configured mode. */
export const make = Effect.gen(function* () {
  const config = yield* MediaConfig.Service;
  const tools = yield* MediaTools.Service;
  const disabled = yield* Ref.make(config.hardwareAcceleration === "none");

  const probe = yield* Effect.cached(
    config.hardwareAcceleration === "qsv"
      ? Effect.succeed(true)
      : tools.ffmpeg(qsvProbeArgs(config.qsvDevice)).pipe(
          Effect.timeout("15 seconds"),
          Effect.as(true),
          Effect.tapError((error) => Effect.logInfo("HardwareAcceleration.qsv_unavailable", error)),
          Effect.orElseSucceed(() => false),
          Effect.tap((available) =>
            Effect.logInfo("HardwareAcceleration.probed").pipe(
              Effect.annotateLogs({ qsv: available }),
            ),
          ),
        ),
  );

  const qsvAvailable = Effect.gen(function* () {
    if (yield* Ref.get(disabled)) return false;

    return yield* probe;
  });

  const markQsvUnavailable = Effect.fn("HardwareAcceleration.markQsvUnavailable")(function* (
    reason: string,
  ) {
    yield* Ref.set(disabled, true);
    yield* Effect.logWarning("HardwareAcceleration.qsv_disabled").pipe(
      Effect.annotateLogs({ reason }),
    );
  });

  return Service.of({ qsvAvailable, markQsvUnavailable, qsvDevice: config.qsvDevice });
});

/** Availability from `HARDWARE_ACCELERATION` and `QSV_DEVICE`. */
export const layer: Layer.Layer<Service, never, MediaConfig.Service | MediaTools.Service> =
  Layer.effect(Service, make);
