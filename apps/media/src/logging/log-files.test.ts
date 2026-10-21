import { Option } from "effect";
import { assert, describe, it } from "vitest";

import { createdAtOf, fileName, type LogFile, planPrune } from "./log-files.ts";

const DAY = 86_400_000;

/** A file created `createdAt` and last written `modifiedAt`, of `sizeBytes`. */
const file = (createdAt: number, sizeBytes: number, modifiedAt = createdAt): LogFile => ({
  name: fileName(createdAt),
  createdAt,
  sizeBytes,
  modifiedAt,
});

describe("log file names", () => {
  it("round-trips the creation time and ignores other files", () => {
    const createdAt = Date.UTC(2026, 9, 21, 14, 5, 3, 123);

    assert.strictEqual(fileName(createdAt), "media-20261021T140503123Z.ndjson");
    assert.deepStrictEqual(createdAtOf(fileName(createdAt)), Option.some(createdAt));
    assert.isTrue(Option.isNone(createdAtOf("notes.txt")));
    assert.isTrue(Option.isNone(createdAtOf("media-20261021T140503123Z.ndjson.gz")));
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
