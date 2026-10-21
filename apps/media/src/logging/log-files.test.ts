import { Option } from "effect";
import { assert, describe, it } from "vitest";

import {
  fileCapBytes,
  fileName,
  type LogFile,
  MIN_LOG_BYTES,
  orderOf,
  planPrune,
  shouldRotate,
} from "./log-files.ts";

const DAY = 86_400_000;

/** A file of records from `startsAt` to `modifiedAt`, of `sizeBytes`. */
const file = (startsAt: number, sizeBytes: number, modifiedAt = startsAt): LogFile => ({
  name: fileName(startsAt),
  startsAt,
  sequence: 0,
  sizeBytes,
  modifiedAt,
});

describe("log file names", () => {
  it("round-trips the start time and sequence, and ignores other files", () => {
    const startsAt = Date.UTC(2026, 9, 21, 14, 5, 3, 123);

    assert.strictEqual(fileName(startsAt), "media-20261021T140503123Z.ndjson");
    assert.strictEqual(fileName(startsAt, 2), "media-20261021T140503123Z-2.ndjson");
    assert.deepStrictEqual(orderOf(fileName(startsAt)), Option.some({ startsAt, sequence: 0 }));
    assert.deepStrictEqual(orderOf(fileName(startsAt, 2)), Option.some({ startsAt, sequence: 2 }));
    assert.isTrue(Option.isNone(orderOf("notes.txt")));
    assert.isTrue(Option.isNone(orderOf("media-20261021T140503123Z.ndjson.gz")));
    assert.isTrue(Option.isNone(orderOf("media-20261021T140503123Z-0.ndjson")));
  });
});

describe("file size", () => {
  it("gives each file an eighth of the cap, so the smallest cap still keeps eight files", () => {
    assert.strictEqual(fileCapBytes(MIN_LOG_BYTES), MIN_LOG_BYTES / 8);
    assert.strictEqual(fileCapBytes(512 * 1024 * 1024), 64 * 1024 * 1024);
    assert.strictEqual(fileCapBytes(4096 * 1024 * 1024), 64 * 1024 * 1024);
  });

  it("starts another file before a write would grow the current one past its share", () => {
    const now = Date.UTC(2026, 9, 21, 12);
    const current = { startsAt: now, sizeBytes: 90 };

    assert.isFalse(shouldRotate(current, now, 100, 10));
    assert.isTrue(shouldRotate(current, now, 100, 11));
    assert.isTrue(shouldRotate(current, now + DAY, 100, 0));
  });
});

describe("retention", () => {
  const now = Date.UTC(2026, 9, 21);
  const retention = { maxAgeMs: 14 * DAY, maxBytes: 100 };

  it("deletes files last written before the retention period", () => {
    const old = file(now - 20 * DAY, 10, now - 15 * DAY);
    const recent = file(now - 20 * DAY + 1, 10, now - 13 * DAY);

    assert.deepStrictEqual(planPrune([recent, old], retention, now, Option.none()), [old.name]);
  });

  it("deletes the oldest files until the rest fit the size cap", () => {
    const oldest = file(now - 3, 60);
    const files = [oldest, file(now - 2, 30), file(now - 1, 30)];

    assert.deepStrictEqual(planPrune(files, retention, now, Option.none()), [oldest.name]);
  });

  it("makes room for what is about to be written", () => {
    const files = [file(now - 3, 30), file(now - 2, 30), file(now - 1, 30)];

    assert.deepStrictEqual(planPrune(files, retention, now, Option.none(), 10), []);
    assert.deepStrictEqual(planPrune(files, retention, now, Option.none(), 11), [
      fileName(now - 3),
    ]);
  });

  it("never deletes the file being written", () => {
    const active = file(now - 20 * DAY, 500, now - 15 * DAY);

    assert.deepStrictEqual(planPrune([active], retention, now, Option.some(active.name)), []);
  });

  it("deletes nothing more when run again on what it left", () => {
    const files = [
      file(now - 30 * DAY, 10, now - 30 * DAY),
      file(now - 3, 60),
      file(now - 2, 30),
      file(now - 1, 30),
    ];

    const doomed = new Set(planPrune(files, retention, now, Option.none()));
    const left = files.filter((candidate) => !doomed.has(candidate.name));

    assert.deepStrictEqual(planPrune(left, retention, now, Option.none()), []);
  });
});
