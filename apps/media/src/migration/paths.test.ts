import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";

import { isInside, mappingCandidates, normalizePath, toLocalPath } from "./paths.ts";

const Segment = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9 ._-]{0,11}$/u));

const Segments = Schema.Array(Segment).check(Schema.isMinLength(1), Schema.isMaxLength(5));

describe("normalizePath", () => {
  it("unifies separators, repeated and trailing slashes, and Unicode forms", () => {
    assert.strictEqual(normalizePath("/data//movies/"), "/data/movies");
    assert.strictEqual(normalizePath("D:\\Media\\Movies\\"), "D:/Media/Movies");
    assert.strictEqual(normalizePath("D:\\"), "D:/");
    assert.strictEqual(normalizePath("/"), "/");
    assert.strictEqual(normalizePath("/films/Ame\u0301lie"), "/films/Am\u00e9lie");
  });
});

describe("isInside", () => {
  it("respects segment boundaries and compares Windows drives without case", () => {
    assert.isTrue(isInside("/data/movies/a.mkv", "/data/movies"));
    assert.isTrue(isInside("/data/movies", "/data/movies/"));
    assert.isFalse(isInside("/data/movies-4k/a.mkv", "/data/movies"));
    assert.isTrue(isInside("d:\\media\\a.mkv", "D:/Media"));
    assert.isFalse(isInside("/Data/movies/a.mkv", "/data/movies"));
  });
});

describe("toLocalPath", () => {
  const mappings = [
    { from: "/data", to: "/mnt/nas" },
    { from: "/data/movies", to: "/mnt/movies" },
    { from: "D:\\Media", to: "/mnt/windows" },
  ];

  it("uses the longest matching mapping", () => {
    assert.strictEqual(
      toLocalPath("/data/movies/Heat (1995)/Heat.mkv", mappings, []),
      "/mnt/movies/Heat (1995)/Heat.mkv",
    );
    assert.strictEqual(toLocalPath("/data/shows/x.mkv", mappings, []), "/mnt/nas/shows/x.mkv");
    assert.strictEqual(toLocalPath("d:/media/Film.mkv", mappings, []), "/mnt/windows/Film.mkv");
  });

  it("keeps paths already inside an approved root, and gives up on the rest", () => {
    assert.strictEqual(toLocalPath("/srv/media/a.mkv", [], ["/srv/media"]), "/srv/media/a.mkv");
    assert.isNull(toLocalPath("/elsewhere/a.mkv", [], ["/srv/media"]));
    assert.isNull(toLocalPath("/data-other/a.mkv", mappings, []));
  });

  it.prop(
    "maps every path under `from` to the same relative path under `to`",
    { source: Segments, relative: Segments, target: Segments },
    ({ source, relative, target }) => {
      const from = `/${source.join("/")}`;
      const to = `/${target.join("/")}`;
      const local = toLocalPath(`${from}/${relative.join("/")}`, [{ from, to }], []);

      assert.strictEqual(local, normalizePath(`${to}/${relative.join("/")}`));
      assert.isTrue(local !== null && isInside(local, to));
    },
  );
});

describe("mappingCandidates", () => {
  it("proposes the root itself when names match, then the folder's tail under each root", () => {
    assert.deepStrictEqual(mappingCandidates("/data/movies", ["/mnt/nas/movies", "/mnt/nas"]), [
      "/mnt/nas/movies",
      "/mnt/nas/movies/movies",
      "/mnt/nas/movies/data/movies",
      "/mnt/nas/data/movies",
    ]);
    assert.deepStrictEqual(mappingCandidates("D:\\Media\\Shows", ["/srv"]), [
      "/srv/Shows",
      "/srv/Media/Shows",
    ]);
  });
});
