/**
 * The player (F01–F14): the video full screen in landscape with its controls, sheets, and states.
 * `usePlaybackSession` starts the session and reports progress through the controller's port, so
 * closing the player ends the session and Continue Watching shows where it stopped. A session that
 * ended elsewhere, or could not start, starts again at the same position with a new key.
 */
import type { EpisodeId } from "@movies/contracts/ids";
import type { SeasonEpisode } from "@movies/contracts/models/catalog";
import { Milliseconds } from "@movies/contracts/units";
import type { Playback } from "@movies/sdk/effect";
import { useCommandQuery, useMoviesRuntime, usePlaybackSession } from "@movies/sdk/react";
import * as Brightness from "expo-brightness";
import { useKeepAwake } from "expo-keep-awake";
import { router } from "expo-router";
import { VideoView } from "expo-video";
import type { VideoMetadata } from "expo-video";
import { ChevronLeft, LockKeyhole } from "lucide-react-native";
import { Option, Result } from "effect";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Icon } from "@/components/ui/icon";
import { Image } from "@/components/ui/image";
import { Text } from "@/components/ui/text";
import { artworkUrl } from "@/lib/artwork";
import { deviceId, deviceName } from "@/lib/device";
import { IOS_CAPABILITIES } from "@/lib/player/capabilities";
import { NEXT_COUNTDOWN, inCredits } from "@/lib/player/next-episode";
import { MAX_RECOVERIES, PlaybackStep, PlaybackStop, afterStartFailure } from "@/lib/player/policy";
import { chapterRows, scrubTileAt } from "@/lib/player/scrubbing";
import type { ScrubTile } from "@/lib/player/scrubbing";
import type { VideoState } from "@/lib/player/video-port";
import type { WatchParams } from "@/lib/routes";
import { useActiveProfile } from "@/session/active-profile";
import { useServer } from "@/session/connection";

import { NextEpisodeCard } from "./next-episode-card";
import { PlayerController, PlayerPhase } from "./playback-controller";
import type { PlayerSnapshot } from "./playback-controller";
import { PLAYER_MARGINS, PlayerControls, RoundButton, useMargin } from "./player-controls";
import type { MoreItem } from "./player-controls";
import {
  AudioSubtitlesPanel,
  ChaptersPanel,
  EpisodesPanel,
  ProblemPanel,
  QualityPanel,
  ResumePanel,
  SpeedPanel,
  speedLabel,
} from "./player-panels";
import { Spinner } from "./spinner";
import { SubtitleOverlay } from "./subtitle-overlay";

/** How long the controls stay up without a touch while playing. */
const CONTROLS_HIDE_MS = 4_000;

/** How long Unlock Controls shows after a touch on locked controls. */
const UNLOCK_HINT_MS = 3_000;

/** A sheet over the player. */
type Panel = "audio" | "quality" | "speed" | "episodes" | "chapters";

/** One try at a session: where it starts and whether a saved position may ask to resume. */
interface Attempt {
  readonly key: number;
  /** Where to start; none for the saved progress. */
  readonly startAtMs: number | null;
  readonly askResume: boolean;
  /** Tries in a row that failed to start. */
  readonly failures: number;
}

const IDLE_SNAPSHOT: PlayerSnapshot = {
  phase: PlayerPhase.Preparing(),
  playback: null,
  video: null,
  audioStreamIndex: null,
  subtitleId: null,
  subtitleDelayMs: 0,
  quality: "auto",
  rate: 1,
};

const IDLE_STATE: VideoState = {
  positionSeconds: 0,
  playing: false,
  buffering: false,
  ended: false,
};

const subscribeNothing = (): (() => void) => () => undefined;

/** The screen's brightness, starting from the system's and put back on leaving. */
const useBrightness = (): readonly [number, (value: number) => void] => {
  const [level, setLevel] = useState(0.5);

  useEffect(() => {
    let original: number | null = null;

    const read = async (): Promise<void> => {
      try {
        const value = await Brightness.getBrightnessAsync();

        original = value;
        setLevel(value);
      } catch {
        // Without a reading the slider starts halfway; setting it still works.
      }
    };

    void read();

    return () => {
      if (original !== null) void Brightness.setBrightnessAsync(original).catch(() => undefined);
    };
  }, []);

  const set = useCallback((value: number) => {
    setLevel(value);
    void Brightness.setBrightnessAsync(value).catch(() => undefined);
  }, []);

  return [level, set] as const;
};

/**
 * Why a new session starts: the same request again (after a start that failed, `failed` counting
 * toward the retry limit), or at a position playback reached before its session ended elsewhere.
 */
type Restart =
  | { readonly kind: "again"; readonly failed: boolean }
  | { readonly kind: "at"; readonly positionMs: number };

/** Props for `PlayerSession`. */
interface PlayerSessionProps {
  readonly params: WatchParams;
  readonly attempt: Attempt;
  readonly onRestart: (restart: Restart) => void;
}

/** One playback session in the player. */
function PlayerSession({ params, attempt, onRestart }: PlayerSessionProps) {
  const runtime = useMoviesRuntime();
  const { profile } = useActiveProfile();
  const { mediaUrl } = useServer();
  const [controller, setController] = useState<PlayerController | null>(null);
  const restart = useRef(onRestart);

  useEffect(() => {
    restart.current = onRestart;
  }, [onRestart]);

  useEffect(() => {
    const created = new PlayerController(runtime, {
      onNewSession: (positionMs) => restart.current({ kind: "at", positionMs }),
    });

    setController(created);

    return () => {
      created.dispose();
      setController(null);
    };
  }, [runtime]);

  const request = useMemo(
    (): Playback.PlaybackRequest => ({
      profileId: profile.id,
      deviceId: deviceId(),
      deviceName: Option.some(deviceName()),
      titleId: params.titleId,
      episodeId: Option.fromNullishOr(params.episodeId),
      fileId: Option.fromNullishOr(params.fileId),
      roomId: Option.none(),
      capabilities: IOS_CAPABILITIES,
      startAtMs:
        attempt.startAtMs === null
          ? Option.none()
          : Option.some(Milliseconds.make(attempt.startAtMs)),
      audioStreamIndex: Option.none(),
      quality: Option.none(),
    }),
    [profile.id, params, attempt.startAtMs],
  );

  const session = usePlaybackSession(
    controller === null ? null : request,
    controller?.port ?? null,
  );

  useEffect(() => {
    if (controller !== null && session !== null && Result.isSuccess(session)) {
      controller.start(session.success, attempt.askResume);
    }
  }, [controller, session, attempt.askResume]);

  // A session that could not start tries the same request again after the pause its failure calls
  // for, keeping where it was asked to start (the saved progress, and its resume prompt).
  const startStep = useMemo(
    () =>
      session !== null && Result.isFailure(session) ? afterStartFailure(session.failure) : null,
    [session],
  );

  const retryable =
    startStep !== null && !PlaybackStep.$is("Stop")(startStep) && attempt.failures < MAX_RECOVERIES;

  useEffect(() => {
    if (startStep === null || !retryable) return undefined;

    const afterMs = PlaybackStep.$is("Renegotiate")(startStep) ? startStep.afterMs : 0;
    const timer = setTimeout(() => restart.current({ kind: "again", failed: true }), afterMs);

    return () => clearTimeout(timer);
  }, [startStep, retryable]);

  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? subscribeNothing,
    () => controller?.getSnapshot() ?? IDLE_SNAPSHOT,
  );

  const media = useSyncExternalStore(
    controller?.port.subscribeState ?? subscribeNothing,
    () => controller?.port.getState() ?? IDLE_STATE,
  );

  const detail = useCommandQuery("titles.get", { profileId: profile.id, titleId: params.titleId });
  const title = detail.status === "success" ? detail.data : null;
  const started = snapshot.playback?.started ?? null;
  const episode = started?.episode ?? null;

  const nextEpisode = useCommandQuery(
    "playback.nextEpisode",
    episode === null ? "skip" : { profileId: profile.id, episodeId: episode.id },
  );

  const seasonEpisodes = useCommandQuery(
    "titles.episodes",
    episode === null
      ? "skip"
      : { profileId: profile.id, titleId: params.titleId, seasonNumber: episode.seasonNumber },
  );

  useEffect(() => {
    if (controller === null || title === null) return;

    const metadata: VideoMetadata = { title: episode === null ? title.name : episode.name };
    const artwork = artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "card");

    if (episode !== null) metadata.artist = title.name;

    if (artwork !== undefined) metadata.artwork = artwork;
    controller.setMetadata(metadata);
  }, [controller, title, episode, mediaUrl]);

  useKeepAwake();

  const [brightness, setBrightness] = useBrightness();
  const [volume, setVolume] = useState(1);
  const [visible, setVisible] = useState(true);
  const [held, setHeld] = useState(false);
  const [touch, setTouch] = useState(0);
  const [locked, setLocked] = useState(false);
  const [unlockHint, setUnlockHint] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [creditsDismissed, setCreditsDismissed] = useState(false);

  const poke = useCallback((holding?: boolean) => {
    setVisible(true);
    setTouch((count) => count + 1);

    if (holding !== undefined) setHeld(holding);
  }, []);

  // Playing, the controls step away after a few seconds without a touch, counted from the first
  // frame.
  const shown = PlayerPhase.$is("Playing")(snapshot.phase);

  useEffect(() => {
    if (!visible || held || panel !== null || !media.playing || !shown) return undefined;

    const timer = setTimeout(() => setVisible(false), CONTROLS_HIDE_MS);

    return () => clearTimeout(timer);
  }, [visible, held, panel, media.playing, shown, touch]);

  useEffect(() => {
    if (!unlockHint) return undefined;

    const timer = setTimeout(() => setUnlockHint(false), UNLOCK_HINT_MS);

    return () => clearTimeout(timer);
  }, [unlockHint]);

  const durationSeconds = (started?.file.probe.durationMs ?? 0) / 1000;
  const stop = startStep !== null && PlaybackStep.$is("Stop")(startStep) ? startStep.stop : null;
  const stopped = PlayerPhase.$is("Stopped")(snapshot.phase) ? snapshot.phase.stop : stop;
  const failedStart = startStep !== null && !retryable && stop === null;
  const playing = PlayerPhase.$is("Playing")(snapshot.phase);
  const choosing = PlayerPhase.$is("Choosing")(snapshot.phase) ? snapshot.phase : null;

  const next = nextEpisode.status === "success" ? nextEpisode.data : null;

  const credits =
    playing &&
    inCredits({
      positionSeconds: media.positionSeconds,
      durationSeconds,
      playing: media.playing,
      ended: media.ended,
    });

  const showNext = credits && next !== null && !creditsDismissed && panel === null && !locked;
  const [countdownStart, setCountdownStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!showNext) {
      setCountdownStart(null);

      return undefined;
    }

    setCountdownStart(Date.now());
    setNow(Date.now());

    const timer = setInterval(() => setNow(Date.now()), NEXT_COUNTDOWN.stepMs / 4);

    return () => clearInterval(timer);
  }, [showNext]);

  const countdownMs =
    countdownStart === null
      ? NEXT_COUNTDOWN.totalMs
      : NEXT_COUNTDOWN.totalMs - (now - countdownStart);

  const playEpisode = useCallback(
    (episodeId: EpisodeId) => {
      // The same screen with another episode: its key changes, so a new session starts, resuming
      // where the profile stopped. A version chosen for this episode does not carry over.
      router.setParams({ episodeId, fileId: undefined, start: undefined });
    },
    [params.titleId],
  );

  useEffect(() => {
    if (showNext && countdownStart !== null && countdownMs <= 0) playEpisode(next.id);
  }, [showNext, next, countdownStart, countdownMs, playEpisode]);

  const tileAt = useCallback(
    (seconds: number): ScrubTile | null =>
      started === null ? null : scrubTileAt(started, seconds),
    [started],
  );

  const chapters = useMemo(() => chapterRows(started?.file.probe.chapters ?? []), [started]);

  const more: ReadonlyArray<MoreItem> = [
    ...(episode === null
      ? []
      : [
          {
            label: "Episodes",
            systemImage: "list.bullet.rectangle",
            onPress: () => setPanel("episodes"),
          } as const,
        ]),
    ...(chapters.length === 0
      ? []
      : [
          {
            label: "Chapters",
            systemImage: "list.number",
            onPress: () => setPanel("chapters"),
          } as const,
        ]),
    { label: "Playback Quality", systemImage: "dial.medium", onPress: () => setPanel("quality") },
  ];

  const close = useCallback(() => {
    router.back();
  }, []);

  const backdrop =
    title === null
      ? undefined
      : artworkUrl(mediaUrl, title.artwork.backdrop ?? title.artwork.poster, "backdrop");

  const subtitleUrl =
    snapshot.playback?.stream.subtitles.find(
      (track) => track.id === snapshot.subtitleId && track.kind === "text",
    )?.url ?? null;

  const name = title?.name ?? "";

  const episodeLine =
    episode === null
      ? null
      : `S${String(episode.seasonNumber)}, E${String(episode.episodeNumber)} · ${episode.name}`;

  const port = controller?.port ?? null;
  const bar = useMargin(PLAYER_MARGINS.bar);

  const seekTo = (seconds: number): void => {
    controller?.seek(Math.min(Math.max(0, seconds), durationSeconds) * 1000);
  };

  const stillOf = (item: Pick<SeasonEpisode, "still">): string | undefined =>
    artworkUrl(mediaUrl, item.still ?? title?.artwork.backdrop, "card");

  return (
    <View className="flex-1 bg-dark-bg">
      {snapshot.video === null ? null : (
        <VideoView
          player={snapshot.video}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls={false}
          allowsPictureInPicture
          startsPictureInPictureAutomatically
          onFirstFrameRender={() => controller?.showedFrame()}
        />
      )}

      {playing || backdrop === undefined ? null : (
        <Image source={{ uri: backdrop }} contentFit="cover" className="absolute inset-0" />
      )}

      <SubtitleOverlay
        url={subtitleUrl}
        positionSeconds={media.positionSeconds}
        delayMs={snapshot.subtitleDelayMs}
        raised={locked ? unlockHint : visible}
      />

      <Pressable
        className="absolute inset-0"
        accessibilityLabel={visible ? "Hide controls" : "Show controls"}
        onPress={() => {
          if (locked) {
            setUnlockHint(true);

            return;
          }

          if (visible) {
            setVisible(false);
            setHeld(false);
          } else {
            poke();
          }
        }}
      />

      {playing && media.buffering ? (
        <View className="absolute inset-0 items-center justify-center" pointerEvents="none">
          <Spinner />
        </View>
      ) : null}

      {visible && playing && !locked && !showNext && stopped === null ? (
        <Animated.View
          entering={FadeIn}
          exiting={FadeOut}
          className="absolute inset-0"
          pointerEvents="box-none"
        >
          <PlayerControls
            title={name}
            detail={episodeLine}
            playing={media.playing}
            positionSeconds={media.positionSeconds}
            durationSeconds={durationSeconds}
            rateLabel={`${speedLabel(snapshot.rate)} Speed`}
            brightness={brightness}
            volume={volume}
            more={more}
            tileAt={tileAt}
            onClose={close}
            onTogglePlay={() => {
              poke();

              if (media.playing) port?.pause();
              else void port?.play();
            }}
            onSeek={(seconds) => {
              poke();
              seekTo(seconds);
            }}
            onLock={() => {
              setLocked(true);
              setVisible(false);
              setUnlockHint(true);
            }}
            onSpeed={() => setPanel("speed")}
            onAudioSubtitles={() => setPanel("audio")}
            onBrightness={setBrightness}
            onVolume={(value) => {
              setVolume(value);
              controller?.setVolume(value);
            }}
            onInteract={poke}
            onDismiss={() => {
              setVisible(false);
              setHeld(false);
            }}
          />
        </Animated.View>
      ) : null}

      {PlayerPhase.$is("Preparing")(snapshot.phase) && stopped === null && !failedStart ? (
        <View className="absolute inset-0 items-center justify-center gap-4 bg-scrim">
          <Spinner />
          <Text variant="status" tone="onMedia">
            Preparing stream…
          </Text>
          <View className="absolute top-0 left-0 h-17 justify-center" style={bar}>
            <RoundButton icon={ChevronLeft} label="Close" onPress={close} />
          </View>
        </View>
      ) : null}

      {showNext ? (
        <NextEpisodeCard
          show={name}
          playing={episodeLine}
          next={next}
          stillUrl={stillOf(next)}
          countdownMs={countdownMs}
          onWatchCredits={() => setCreditsDismissed(true)}
          onPlayNext={() => playEpisode(next.id)}
        />
      ) : null}

      {locked && unlockHint ? (
        <Animated.View
          entering={FadeIn}
          exiting={FadeOut}
          className="absolute right-0 bottom-6 left-0 items-center"
        >
          <Pressable
            onPress={() => {
              setLocked(false);
              setUnlockHint(false);
              poke();
            }}
            accessibilityRole="button"
            accessibilityLabel="Unlock Controls"
            className="h-13 w-46 flex-row items-center justify-center gap-2 rounded-pill bg-dark-surface-raised active:opacity-80"
          >
            <Icon icon={LockKeyhole} tone="onMedia" size="inline" />
            <Text variant="bodyStrong" tone="onMedia">
              Unlock Controls
            </Text>
          </Pressable>
        </Animated.View>
      ) : null}

      {panel === "audio" && started !== null && snapshot.playback !== null ? (
        <AudioSubtitlesPanel
          audio={started.file.probe.audio}
          audioStreamIndex={snapshot.audioStreamIndex}
          subtitles={snapshot.playback.stream.subtitles}
          subtitleId={snapshot.subtitleId}
          subtitleDelayMs={snapshot.subtitleDelayMs}
          onAudio={(index) => controller?.selectAudio(index)}
          onSubtitle={(id) => controller?.selectSubtitle(id)}
          onDelay={(ms) => controller?.setSubtitleDelay(ms)}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "quality" ? (
        <QualityPanel
          quality={snapshot.quality}
          onQuality={(quality) => {
            controller?.selectQuality(quality);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "speed" ? (
        <SpeedPanel
          rate={snapshot.rate}
          onRate={(rate) => {
            controller?.setRate(rate);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "episodes" && episode !== null ? (
        <EpisodesPanel
          title={`${name} · Season ${String(episode.seasonNumber)}`}
          episodes={seasonEpisodes.status === "success" ? seasonEpisodes.data : []}
          playingId={episode.id}
          stillUrl={stillOf}
          onEpisode={(item) => playEpisode(item.id)}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {panel === "chapters" ? (
        <ChaptersPanel
          chapters={chapters}
          onChapter={(chapter) => {
            seekTo(chapter.startSeconds);
            setPanel(null);
          }}
          onClose={() => setPanel(null)}
        />
      ) : null}

      {choosing !== null && stopped === null ? (
        <ResumePanel
          title={episode === null ? name : episode.name}
          resumeAtMs={choosing.resumeAtMs}
          durationMs={durationSeconds * 1000}
          onResume={() => {
            controller?.choose("resume");
            poke();
          }}
          onBeginning={() => {
            controller?.choose("beginning");
            poke();
          }}
          onClose={close}
        />
      ) : null}

      {stopped === null && !failedStart ? null : (
        <StoppedPanel
          stop={stopped}
          onRetry={() => {
            if (snapshot.playback === null) restart.current({ kind: "again", failed: false });
            else controller?.retry();
          }}
          onLowerQuality={snapshot.playback === null ? null : () => controller?.tryLowerQuality()}
          onClose={close}
        />
      )}
    </View>
  );
}

/** F09 and F13 for the way playback stopped. */
function StoppedPanel({
  stop,
  onRetry,
  onLowerQuality,
  onClose,
}: {
  readonly stop: PlaybackStop | null;
  readonly onRetry: () => void;
  /** Tries again below the quality that played; null before any stream played. */
  readonly onLowerQuality: (() => void) | null;
  readonly onClose: () => void;
}) {
  const interrupted = (description: string) => (
    <ProblemPanel
      title="Playback interrupted"
      description={description}
      primary={{ label: "Retry", retry: true, onPress: onRetry }}
      secondary={
        onLowerQuality === null ? null : { label: "Try Lower Quality", onPress: onLowerQuality }
      }
      onClose={onClose}
    />
  );

  if (stop === null) return interrupted("Playback stopped. Try again in a moment.");

  return PlaybackStop.$match(stop, {
    Missing: () => (
      <ProblemPanel
        title="File unavailable"
        description="The library folder can't be reached."
        primary={{ label: "Try Again", retry: false, onPress: onRetry }}
        secondary={{ label: "Choose Another Version", onPress: onClose }}
        onClose={onClose}
      />
    ),
    Unsupported: () => (
      <ProblemPanel
        title="Can't play on iPhone"
        description="This file can't be played or converted for this device."
        primary={{ label: "Choose Another Version", retry: false, onPress: onClose }}
        secondary={null}
        onClose={onClose}
      />
    ),
    Interrupted: ({ message }) => interrupted(message),
  });
}

/** The player for `params`, starting a new session when the last one ended or failed to start. */
export function PlayerScreen({ params }: { readonly params: WatchParams }) {
  const [attempt, setAttempt] = useState<Attempt>({
    key: 0,
    startAtMs: params.start === "beginning" ? 0 : null,
    askResume: params.start !== "beginning",
    failures: 0,
  });

  const restart = useCallback((next: Restart) => {
    setAttempt((current) =>
      next.kind === "again"
        ? { ...current, key: current.key + 1, failures: next.failed ? current.failures + 1 : 0 }
        : { key: current.key + 1, startAtMs: next.positionMs, askResume: false, failures: 0 },
    );
  }, []);

  // The player's own safe area: the modal turns to landscape, where the app's provider would still
  // report the portrait insets.
  return (
    <SafeAreaProvider>
      <PlayerSession key={attempt.key} params={params} attempt={attempt} onRestart={restart} />
    </SafeAreaProvider>
  );
}
