/**
 * Paper 07 · 03 Stream info: how this device receives the file, the one place codec details
 * belong. It reads the file as ffprobe saw it and the stream as negotiated; the media service
 * reports no encoder speed or server load yet, so those rows are left out.
 */
import type { DynamicRange, NegotiateResponse } from "@movies/contracts/media-playback";
import type { HdrFormat, MediaFile } from "@movies/contracts/models/catalog";
import { cn } from "@movies/ui/lib/utils";
import { XIcon } from "lucide-react";

import { channelLabel, codecLabel } from "@/lib/media-facts";

/** The three rungs the segmented control names. */
const RUNGS = [
  { id: "direct", label: "Direct" },
  { id: "remux", label: "Remux" },
  { id: "transcode", label: "Transcode" },
] as const;

const rungOf = (mode: NegotiateResponse["mode"]): (typeof RUNGS)[number]["id"] => {
  if (mode === "direct") return "direct";

  return mode === "remux" || mode === "audio-transcode" ? "remux" : "transcode";
};

const HDR_LABELS = {
  none: "SDR",
  hdr10: "HDR10",
  hdr10plus: "HDR10+",
  hlg: "HLG",
  dolby_vision: "Dolby Vision",
} as const satisfies Record<HdrFormat, string>;

const RANGE_LABELS = {
  sdr: "SDR",
  hdr10: "HDR10",
  hlg: "HLG",
  "dolby-vision": "Dolby Vision",
} as const satisfies Record<DynamicRange, string>;

/** How each rung's name reads when it is the active one. */
const RUNG_TONES = {
  direct: "text-success",
  remux: "text-text",
  transcode: "text-warning",
} as const;

const sizeLabel = (width: number, height: number): string => {
  if (width >= 3200 || height >= 2000) return "4K";

  return `${String(height)}p`;
};

const megabits = (bitsPerSecond: number): string => (bitsPerSecond / 1_000_000).toFixed(1);

/** How each transcode mode's encoder reads in the stream details. */
const ENCODER_LABELS = {
  "transcode-qsv": "Intel QSV",
  "transcode-vaapi": "VA-API",
  "transcode-software": "Software",
} as const;

const CONTAINER_LABELS = new Map([
  ["mkv", "MKV"],
  ["mp4", "MP4"],
  ["mov", "MOV"],
  ["webm", "WebM"],
  ["avi", "AVI"],
  ["ts", "MPEG-TS"],
]);

/** The rows of the panel as label and value lines. */
const streamInfoRows = (
  file: MediaFile,
  stream: NegotiateResponse,
  bufferedAheadSeconds: number,
): ReadonlyArray<{ readonly label: string; readonly lines: ReadonlyArray<string> }> => {
  const source = file.probe.video[0];

  const copiedVideo =
    stream.mode === "direct" || stream.mode === "remux" || stream.mode === "audio-transcode";

  const sourceVideo =
    source === undefined
      ? null
      : [
          `${codecLabel(source.codec)}${(source.bitDepth ?? 8) > 8 ? ` ${String(source.bitDepth)}-bit` : ""}`,
          sizeLabel(source.width, source.height),
          HDR_LABELS[source.hdr],
        ].join(" · ");

  const outputVideo = [
    codecLabel(stream.video.codec),
    sizeLabel(stream.video.width, stream.video.height),
    RANGE_LABELS[stream.video.dynamicRange],
  ].join(" · ");

  const sourceAudio = file.probe.audio.find((track) => track.index === stream.audio?.streamIndex);

  const audio =
    stream.audio === undefined
      ? "None"
      : [
          [codecLabel(stream.audio.codec), channelLabel(stream.audio.channels)]
            .filter((part) => part !== null)
            .join(" "),
          ...(sourceAudio?.bitRate === null || sourceAudio === undefined
            ? []
            : [`${String(Math.round(sourceAudio.bitRate / 1000))} kb/s`]),
          stream.mode === "audio-transcode" || !copiedVideo ? "converted" : "copy",
        ].join(" · ");

  const container =
    CONTAINER_LABELS.get(file.probe.container) ?? file.probe.container.toUpperCase();

  const rows = [
    {
      label: "Video",
      lines:
        copiedVideo || sourceVideo === null
          ? [sourceVideo ?? outputVideo]
          : [sourceVideo, `→ ${outputVideo}`],
    },
    ...(stream.mode === "transcode-qsv" ||
    stream.mode === "transcode-vaapi" ||
    stream.mode === "transcode-software"
      ? [
          {
            label: "Encoder",
            lines: [
              [
                ENCODER_LABELS[stream.mode],
                ...(source !== undefined &&
                source.hdr !== "none" &&
                stream.video.dynamicRange === "sdr"
                  ? ["tone-map"]
                  : []),
              ].join(" · "),
            ],
          },
        ]
      : []),
    { label: "Audio", lines: [audio] },
    {
      label: "Container",
      lines: [stream.mode === "direct" ? container : `${container} → HLS fMP4`],
    },
    {
      label: "Bitrate",
      lines: [
        [
          ...(file.probe.bitRate === null ? [] : [`${megabits(file.probe.bitRate)} Mb/s`]),
          `buffer ${String(Math.round(bufferedAheadSeconds))} s`,
        ].join(" · "),
      ],
    },
  ];

  return rows;
};

/** The floating panel under the info button. */
export function StreamInfo({
  file,
  stream,
  bufferedAheadSeconds,
  onClose,
  className,
}: {
  readonly file: MediaFile;
  readonly stream: NegotiateResponse;
  readonly bufferedAheadSeconds: number;
  readonly onClose: () => void;
  readonly className?: string;
}) {
  const rung = rungOf(stream.mode);

  return (
    <section
      aria-label="Stream info"
      className={cn(
        "on-media flex w-110 max-w-full flex-col gap-5 rounded-card border border-hairline bg-dark-surface-raised px-6 pt-5 pb-6 font-sans shadow-overlay",
        className,
      )}
    >
      <header className="flex items-center justify-between">
        <h2 className="text-body/body font-bold text-text">Stream info</h2>
        <button
          type="button"
          aria-label="Close stream info"
          onClick={onClose}
          className="flex size-6 cursor-pointer items-center justify-center rounded-bar text-text-muted transition-colors hover:text-text"
        >
          <XIcon className="size-5" strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <div
        className="flex gap-0.5 rounded-control bg-dark-bg p-0.75"
        role="list"
        aria-label="Playback mode"
      >
        {RUNGS.map((each) => (
          <span
            key={each.id}
            role="listitem"
            aria-current={each.id === rung || undefined}
            className={cn(
              "flex h-7.5 grow basis-0 items-center justify-center rounded-inner font-mono text-caption/caption tracking-caps uppercase",
              each.id === rung
                ? cn(
                    "border border-hairline bg-dark-surface-raised font-semibold",
                    RUNG_TONES[rung],
                  )
                : "text-text-muted",
            )}
          >
            {each.label}
          </span>
        ))}
      </div>
      <dl className="flex flex-col gap-1">
        {streamInfoRows(file, stream, bufferedAheadSeconds).map((row) => (
          <div key={row.label} className="flex gap-4 py-2">
            <dt className="w-21 shrink-0 text-label/5 text-text-muted">{row.label}</dt>
            <dd className="flex grow basis-0 flex-col gap-0.5">
              {row.lines.map((line, index) => (
                <span
                  key={line}
                  className={cn(
                    "font-mono text-label/5",
                    row.lines.length > 1 && index === 0 ? "text-text-muted" : "text-text",
                  )}
                >
                  {line}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
