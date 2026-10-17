import { Milliseconds } from "@movies/contracts/units";
import { useState } from "react";

import { AutoplayNext } from "@/components/player/autoplay-next";
import type { NextEpisode } from "@/components/player/autoplay-next";

import { ART } from "./sample-art";

/** The bench's next episode, with a synopsis as long as a real one. */
const EPISODE: NextEpisode = {
  seasonNumber: 2,
  episodeNumber: 10,
  name: "The Inheritance",
  overview:
    "Betty visits her father; Paul's girlfriend tries to convince him to prioritize his duties; Pete's mother disapproves of his and Trudy's idea.",
  runtimeMs: Milliseconds.make(48 * 60_000),
};

/** A title long enough to need two lines and then some, as anthology and anime titles run. */
const LONG_NAME =
  "The One Where Everybody Finds Out What Happened at the Lighthouse on the Night of the Longest Storm";

/** The still variants: sample artwork, none at all, or an address that fails to load. */
const STILLS = { art: ART.bear, none: undefined, broken: "/dev/missing-still.jpg" } as const;

/** What the bench shows; see the `/dev/autoplay` route. */
export interface AutoplayBenchOptions {
  readonly still: keyof typeof STILLS;
  readonly title: "short" | "long";
  readonly overview: boolean;
  readonly seconds: number;
  readonly role: "advance" | "follow";
}

/**
 * The next-episode card over a still frame standing in for the credits, at the size of the window,
 * with its countdown held at `seconds`. Its buttons report what they did instead of navigating.
 */
export function AutoplayBench({ still, title, overview, seconds, role }: AutoplayBenchOptions) {
  const [done, setDone] = useState<string | null>(null);

  return (
    <div data-testid="player" className="fixed inset-0 bg-dark-bg text-text">
      <div
        aria-hidden
        className="absolute inset-0 bg-cover bg-center"
        style={{ backgroundImage: `url("${ART.severance}")` }}
      />
      {done === null ? (
        <AutoplayNext
          next={{
            ...EPISODE,
            name: title === "long" ? LONG_NAME : EPISODE.name,
            overview: overview ? EPISODE.overview : null,
          }}
          still={STILLS[still]}
          countdownMs={seconds * 1000}
          actions={
            role === "advance"
              ? {
                  kind: "advance",
                  onPlayNext: () => setDone("Played next"),
                  onWatchCredits: () => setDone("Watching credits"),
                }
              : { kind: "follow", onClose: () => setDone("Closed") }
          }
        />
      ) : (
        <p role="status" className="absolute top-4 left-4 text-body/body">
          {done}
        </p>
      )}
    </div>
  );
}
