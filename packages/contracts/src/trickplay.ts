/**
 * Scrub thumbnails ("trickplay"): small frames of a media file, one every `intervalMs`, tiled into
 * JPEG sprite sheets of `columns` × `rows`. The media service generates them in a `trickplay` job
 * and stores them under its data folder, keyed by the file's ID and a version derived from the
 * file's size and modification time, so a replaced file never shows old frames. Players read the
 * manifest from the file (`MediaFile.trickplay`) and load sheets from
 * `${mediaBaseUrl}/media/trickplay/<fileId>/<version>/<sheet>.jpg?token=…` with the session's
 * playback token: frames are content, so they are authorized like the stream itself.
 */
import { Schema } from "effect";

/** Seconds between thumbnails unless `TRICKPLAY_INTERVAL_SECONDS` says otherwise. */
export const DEFAULT_TRICKPLAY_INTERVAL_SECONDS = 10;

/** Width of one thumbnail in pixels; the height keeps the video's aspect ratio. */
export const TRICKPLAY_TILE_WIDTH = 320;

/** Thumbnails across one sheet. */
export const TRICKPLAY_COLUMNS = 10;

/** Thumbnails down one sheet. */
export const TRICKPLAY_ROWS = 10;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/**
 * Which generation of a file's thumbnails a manifest describes: the file's size and modification
 * time in base 36, such as `1x2k3-lzxbq1c0`.
 */
export const TrickplayVersion = Schema.String.check(
  Schema.isPattern(/^[0-9a-z]{1,16}-[0-9a-z]{1,16}$/u),
);

/** Which generation of a file's thumbnails a manifest describes. */
export type TrickplayVersion = typeof TrickplayVersion.Type;

/** Where a file's scrub thumbnails are and how they are laid out. */
export const TrickplayManifest = Schema.Struct({
  version: TrickplayVersion,
  /** Thumbnail `i` shows the frame at `i * intervalMs`. */
  intervalMs: PositiveInt,
  tileWidth: PositiveInt,
  tileHeight: PositiveInt,
  columns: PositiveInt,
  rows: PositiveInt,
  thumbnailCount: PositiveInt,
  sheetCount: PositiveInt,
});

/** Where a file's scrub thumbnails are and how they are laid out. */
export interface TrickplayManifest extends Schema.Schema.Type<typeof TrickplayManifest> {}

/** The version of thumbnails made from a file of `sizeBytes` last modified at `modifiedAtMs`. */
export const trickplayVersion = (sizeBytes: number, modifiedAtMs: number): TrickplayVersion =>
  `${Math.max(0, Math.trunc(sizeBytes)).toString(36)}-${Math.max(0, Math.trunc(modifiedAtMs)).toString(36)}`;

/** How many thumbnails and sheets a file needs. */
export interface TrickplayLayout {
  readonly thumbnailCount: number;
  readonly sheetCount: number;
}

/** How many thumbnails and sheets a file of `durationMs` needs at `intervalMs`. */
export const trickplayLayout = (
  durationMs: number,
  intervalMs: number,
  perSheet: number,
): TrickplayLayout => {
  const thumbnailCount = Math.max(1, Math.ceil(Math.max(0, durationMs) / intervalMs));

  return { thumbnailCount, sheetCount: Math.ceil(thumbnailCount / perSheet) };
};

/** One thumbnail's place: the sheet (from 0) and its pixel rectangle on that sheet. */
export interface TrickplayTile {
  readonly sheet: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Where the thumbnail's frame is in the file. */
  readonly positionMs: number;
}

/** The thumbnail at or before `positionMs`, clamped to the first and last thumbnails. */
export const trickplayTile = (manifest: TrickplayManifest, positionMs: number): TrickplayTile => {
  const raw = Math.floor(Math.max(0, positionMs) / manifest.intervalMs);
  const index = Math.min(manifest.thumbnailCount - 1, Number.isFinite(raw) ? raw : 0);
  const perSheet = manifest.columns * manifest.rows;
  const onSheet = index % perSheet;

  return {
    sheet: Math.floor(index / perSheet),
    x: (onSheet % manifest.columns) * manifest.tileWidth,
    y: Math.floor(onSheet / manifest.columns) * manifest.tileHeight,
    width: manifest.tileWidth,
    height: manifest.tileHeight,
    positionMs: index * manifest.intervalMs,
  };
};

/** Paths of the trickplay routes, relative to the media service's base URL. */
const trickplayPath = (fileId: string, version: TrickplayVersion, name: string): string =>
  `/media/trickplay/${encodeURIComponent(fileId)}/${version}/${name}`;

const withToken = (mediaBaseUrl: string, path: string, token: string): string =>
  `${mediaBaseUrl.replace(/\/+$/u, "")}${path}?token=${encodeURIComponent(token)}`;

/** The URL of sheet `sheet` (from 0) of a file's thumbnails, with the session's playback token. */
export const trickplaySheetUrl = (
  mediaBaseUrl: string,
  fileId: string,
  manifest: Pick<TrickplayManifest, "version">,
  sheet: number,
  token: string,
): string =>
  withToken(mediaBaseUrl, trickplayPath(fileId, manifest.version, `${String(sheet)}.jpg`), token);

/** The URL of a file's manifest as JSON (`TrickplayManifest`), with the session's playback token. */
export const trickplayManifestUrl = (
  mediaBaseUrl: string,
  fileId: string,
  version: TrickplayVersion,
  token: string,
): string => withToken(mediaBaseUrl, trickplayPath(fileId, version, "manifest.json"), token);
