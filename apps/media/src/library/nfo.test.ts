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
      ratings: {
        tmdb: { value: 6.1 },
        imdb: { value: 7.5, votes: 100 },
        rottenTomatoes: undefined,
        metacritic: undefined,
      },
      genres: ["Animation", "Comedy", "Family"],
      studios: ["Blender Foundation"],
      countries: [],
      tags: [],
      ids: { tmdb: "10378", imdb: "tt1254207", tvdb: undefined },
      season: undefined,
      episode: undefined,
      actors: [
        {
          name: "Bunny",
          role: undefined,
          order: 0,
          thumb: undefined,
          ids: { tmdb: undefined, imdb: undefined, tvdb: undefined },
        },
      ],
      directors: [],
      writers: [],
      collection: undefined,
      trailer: undefined,
      status: undefined,
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
      ratings: {},
      genres: [],
      studios: [],
      countries: [],
      tags: [],
      ids: { tmdb: undefined, imdb: "tt0133093", tvdb: undefined },
      actors: [],
      directors: [],
      writers: [],
    });

    expect(parseNfo("https://www.themoviedb.org/movie/603-the-matrix", "movie")?.ids.tmdb).toBe(
      "603",
    );
  });

  it("reads cast, crew, scores, the set, keywords, and the trailer", () => {
    const nfo = `<movie>
  <title>Alien</title>
  <ratings>
    <rating name="imdb" max="10" default="true"><value>8.5</value><votes>1,000,000</votes></rating>
    <rating name="tomatometerallcritics" max="100"><value>93</value></rating>
    <rating name="metacritic" max="100"><value>89</value></rating>
  </ratings>
  <country>United Kingdom</country>
  <country>United States of America</country>
  <tag>space</tag>
  <tag>xenomorph</tag>
  <set tmdbcolid="8091"><name>Alien Collection</name><overview>Four films.</overview></set>
  <trailer>plugin://plugin.video.youtube/?action=play_video&amp;videoid=LjLamj-b0I8</trailer>
  <director>Ridley Scott</director>
  <credits>Dan O'Bannon</credits>
  <credits>Ronald Shusett</credits>
  <writer>Dan O'Bannon</writer>
  <actor><name>Tom Skerritt</name><role>Dallas</role><order>1</order></actor>
  <actor>
    <name>Sigourney Weaver</name><role>Ripley</role><order>0</order>
    <thumb>https://image.tmdb.org/t/p/original/sigourney.jpg</thumb><tmdbid>10205</tmdbid>
  </actor>
  <actor><name>Ridley Scott</name><type>Director</type></actor>
</movie>`;

    const parsed = parseNfo(nfo, "movie");

    expect(parsed?.ratings).toStrictEqual({
      tmdb: undefined,
      imdb: { value: 8.5, votes: 1_000_000 },
      rottenTomatoes: 93,
      metacritic: 89,
    });
    expect(parsed?.countries).toStrictEqual(["United Kingdom", "United States of America"]);
    expect(parsed?.tags).toStrictEqual(["space", "xenomorph"]);
    expect(parsed?.collection).toStrictEqual({
      name: "Alien Collection",
      overview: "Four films.",
      tmdb: "8091",
    });
    expect(parsed?.trailer).toBe("LjLamj-b0I8");
    expect(parsed?.directors).toStrictEqual(["Ridley Scott"]);
    expect(parsed?.writers).toStrictEqual(["Dan O'Bannon", "Ronald Shusett"]);
    expect(parsed?.actors.map((actor) => [actor.name, actor.role, actor.ids.tmdb])).toStrictEqual([
      ["Sigourney Weaver", "Ripley", "10205"],
      ["Tom Skerritt", "Dallas", undefined],
    ]);
  });

  it("reads a plain set, a show's status, and a YouTube URL trailer", () => {
    const show = parseNfo(
      `<tvshow><title>Show</title><status>Continuing</status>
        <trailer>https://www.youtube.com/watch?v=abcDEF12345</trailer></tvshow>`,
      "show",
    );

    expect(show?.status).toBe("returning");
    expect(show?.trailer).toBe("abcDEF12345");
    expect(parseNfo("<movie><set>Plain Set</set></movie>", "movie")?.collection).toStrictEqual({
      name: "Plain Set",
      overview: undefined,
      tmdb: undefined,
    });
    expect(parseNfo("<movie><trailer>/local/trailer.mkv</trailer></movie>", "movie")?.trailer).toBe(
      undefined,
    );
  });

  it("ignores another kind of NFO and unbalanced markup", () => {
    expect(parseNfo("<tvshow><title>Show</title></tvshow>", "movie")).toBeUndefined();
    expect(parseNfo("<movie><title>Open <b>bold</movie>", "movie")?.title).toBe("Open");
    expect(parseNfo("not an nfo", "movie")).toBeUndefined();
  });
});
