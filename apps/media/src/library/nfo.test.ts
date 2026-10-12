import { describe, expect, it } from "@effect/vitest";

import { parseNfo } from "./nfo.ts";

describe("parseNfo", () => {
  it("reads a Kodi movie NFO", () => {
    const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- written by a media manager -->
<movie>
  <title>Big Buck Bunny</title>
  <originaltitle>Big Buck Bunny</originaltitle>
  <sorttitle>Bunny, Big Buck</sorttitle>
  <year>2008</year>
  <plot>A rabbit &amp; three rodents. &#x2014; dash &quot;quoted&quot;</plot>
  <tagline>Rabbit tails</tagline>
  <runtime>10</runtime>
  <mpaa>PG</mpaa>
  <ratings>
    <rating name="themoviedb" max="10"><value>6.1</value></rating>
    <rating name="imdb" max="10" default="true"><value>7.5</value><votes>100</votes></rating>
  </ratings>
  <genre>Animation</genre>
  <genre>Comedy / Family</genre>
  <studio>Blender Foundation</studio>
  <premiered>2008-05-20</premiered>
  <uniqueid type="tmdb" default="true">10378</uniqueid>
  <uniqueid type="imdb">tt1254207</uniqueid>
  <actor><name>Bunny</name></actor>
</movie>`;

    expect(parseNfo(nfo, "movie")).toStrictEqual({
      kind: "movie",
      title: "Big Buck Bunny",
      originalTitle: "Big Buck Bunny",
      sortTitle: "Bunny, Big Buck",
      year: 2008,
      releaseDate: "2008-05-20",
      plot: 'A rabbit & three rodents. — dash "quoted"',
      tagline: "Rabbit tails",
      runtimeMinutes: 10,
      contentRating: "PG",
      rating: 7.5,
      genres: ["Animation", "Comedy", "Family"],
      studios: ["Blender Foundation"],
      ids: { tmdb: "10378", imdb: "tt1254207", tvdb: undefined },
      season: undefined,
      episode: undefined,
    });
  });

  it("reads legacy id elements, a plain rating, and CDATA", () => {
    const nfo = `<tvshow><title>Show</title><plot><![CDATA[Bars <b>&</b> tone]]></plot>
      <rating>8,2</rating><id>tt0000001</id><tvdbid>42</tvdbid><aired>2021-01-01</aired></tvshow>`;

    const parsed = parseNfo(nfo, "show");

    expect(parsed?.plot).toBe("Bars <b>&</b> tone");
    expect(parsed?.rating).toBe(8.2);
    expect(parsed?.year).toBe(2021);
    expect(parsed?.ids).toStrictEqual({ tmdb: undefined, imdb: "tt0000001", tvdb: "42" });
  });

  it("picks the matching block of a multi-episode NFO", () => {
    const nfo = `<episodedetails><title>One</title><season>1</season><episode>3</episode></episodedetails>
<episodedetails><title>Two</title><season>1</season><episode>4</episode></episodedetails>`;

    expect(parseNfo(nfo, "episode", 4)?.title).toBe("Two");
    expect(parseNfo(nfo, "episode")?.title).toBe("One");
  });

  it("reads a URL-only NFO", () => {
    expect(parseNfo("https://www.imdb.com/title/tt0133093/\n", "movie")).toStrictEqual({
      kind: "movie",
      genres: [],
      studios: [],
      ids: { tmdb: undefined, imdb: "tt0133093", tvdb: undefined },
    });

    expect(parseNfo("https://www.themoviedb.org/movie/603-the-matrix", "movie")?.ids.tmdb).toBe(
      "603",
    );
  });

  it("ignores another kind of NFO and unbalanced markup", () => {
    expect(parseNfo("<tvshow><title>Show</title></tvshow>", "movie")).toBeUndefined();
    expect(parseNfo("<movie><title>Open <b>bold</movie>", "movie")?.title).toBe("Open");
    expect(parseNfo("not an nfo", "movie")).toBeUndefined();
  });
});
