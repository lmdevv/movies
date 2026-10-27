#!/usr/bin/env node
// A Chromium that stays open between commands, so a verification can drive the [movies] web app
// one step at a time. `serve` starts the host for one side of a run; every other command sends one
// action to it and prints the result. verify-movies.sh calls this; agents call it through
// `verify-movies.sh browser`.
//
//   node browser.mjs serve --state <dir> --base <url>
//   node browser.mjs <command> --state <dir> [flags]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const OWNER = { name: "Lucía", email: "admin@movies.local", password: "password123" };

// Runs in every page before the app: records each media element that plays, including detached
// ones, so `video` reports real playback rather than what the player's buttons show.
const TRACK_MEDIA = `(() => {
  window.moviesVerifyMedia = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.moviesVerifyMedia.add(this);
    return play.call(this);
  };
})();`;

const FLAGS = {
  state: { type: "string" },
  base: { type: "string" },
  page: { type: "string", default: "main" },
  device: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  dark: { type: "boolean", default: false },
  light: { type: "boolean", default: false },
  "show-actions": { type: "boolean", default: false },
  role: { type: "string" },
  name: { type: "string" },
  exact: { type: "boolean", default: false },
  label: { type: "string" },
  text: { type: "string" },
  testid: { type: "string" },
  css: { type: "string" },
  in: { type: "string" },
  nth: { type: "string" },
  value: { type: "string" },
  key: { type: "string" },
  attr: { type: "string" },
  path: { type: "string" },
  full: { type: "boolean", default: false },
  hidden: { type: "boolean", default: false },
  url: { type: "string" },
  timeout: { type: "string" },
  past: { type: "string" },
  advance: { type: "string" },
  js: { type: "string" },
  email: { type: "string" },
  password: { type: "string" },
  profile: { type: "string" },
  pin: { type: "string" },
  kids: { type: "boolean", default: false },
  movies: { type: "string" },
  shows: { type: "string" },
  code: { type: "string" },
  "invite-role": { type: "string" },
};

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: FLAGS,
  strict: true,
});
const [command, ...rest] = positionals;
if (!command || !flags.state) {
  console.error("usage: browser.mjs <command> --state <dir> [flags]");
  process.exit(2);
}

if (command === "serve") {
  await serve(flags.state, flags.base);
} else {
  await send(flags.state, command, rest, flags);
}

async function send(state, name, args, options) {
  let port;
  try {
    port = readFileSync(join(state, "browser.port"), "utf8").trim();
  } catch {
    console.error("no browser host for this side; run `verify-movies.sh up` first");
    process.exit(1);
  }
  const body = { ...options, command: name, args, cwd: process.cwd() };
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`the browser host on port ${port} does not answer: ${error.message}`);
    process.exit(1);
  }
  const result = await response.json();
  if (result.output !== undefined && result.output !== "") console.log(result.output);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

async function serve(state, base) {
  if (!base) throw new Error("serve needs --base");
  const { chromium, devices } = await import("@playwright/test");
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  /** @type {Map<string, {context: any, page: any, viewport: any, recording: any, streams: any}>} */
  const pages = new Map();

  const pageFor = async (options) => {
    const existing = pages.get(options.page);
    if (existing) return existing;
    const device = options.device ? devices[options.device] : undefined;
    if (options.device && !device) throw new Error(`unknown Playwright device "${options.device}"`);
    const viewport =
      options.width && options.height
        ? { width: Number(options.width), height: Number(options.height) }
        : (device?.viewport ?? { width: 1440, height: 900 });
    // Dark is the app's default theme and follows the system; --light asks for the light one.
    const context = await browser.newContext({
      ...device,
      viewport,
      baseURL: base,
      colorScheme: options.light ? "light" : "dark",
    });
    await context.addInitScript({ content: TRACK_MEDIA });
    const page = await context.newPage();
    // What the player fetched, so `video` can say whether it played the file or an HLS stream.
    // Counted per page address, so a title opened after another starts from zero.
    const streams = { direct: 0, hls: 0 };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      streams.direct = 0;
      streams.hls = 0;
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/media/hls/")) streams.hls += 1;
      else if (path.startsWith("/media/direct/") || path.startsWith("/media/file/")) streams.direct += 1;
    });
    // Screencast frames come at this size; the device's pixel ratio, up to 2, keeps text sharp.
    const scale = Math.min(device?.deviceScaleFactor ?? 1, 2);
    const frame = { width: viewport.width * scale, height: viewport.height * scale };
    const entry = { context, page, viewport: frame, recording: null, streams };
    pages.set(options.page, entry);
    return entry;
  };

  const locate = (page, options) => {
    let scope = page;
    if (options.in) {
      const [role, ...name] = options.in.split("=");
      scope =
        name.length > 0
          ? page.getByRole(role, { name: name.join("="), exact: true })
          : page.getByRole(role);
    }
    const kinds = ["role", "label", "text", "testid", "css"].filter((kind) => options[kind]);
    if (kinds.length === 0 && options.in) return scope;
    if (kinds.length !== 1) {
      throw new Error("name the element with exactly one of --role, --label, --text, --testid, --css");
    }
    const exact = options.exact;
    let locator;
    if (options.role) {
      locator = scope.getByRole(options.role, options.name ? { name: options.name, exact } : {});
    } else if (options.label) locator = scope.getByLabel(options.label, { exact });
    else if (options.text) locator = scope.getByText(options.text, { exact });
    else if (options.testid) locator = scope.getByTestId(options.testid);
    else locator = scope.locator(options.css);
    return options.nth === undefined ? locator : locator.nth(Number(options.nth));
  };

  const hasLocator = (options) =>
    ["role", "label", "text", "testid", "css", "in"].some((kind) => options[kind]);

  const timeout = (options) => Number(options.timeout ?? 30_000);

  const output = (options, file) => {
    if (!file) throw new Error("this command needs --path");
    const path = resolve(options.cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  };

  // Real playback: the page's media elements, their clock, and what the player fetched. A video
  // that plays has `currentTime` growing; a play button that changed proves nothing.
  const media = async (entry) => {
    const now = await entry.page.evaluate(() => {
      const elements = [
        ...new Set([...(window.moviesVerifyMedia ?? []), ...document.querySelectorAll("video, audio")]),
      ];
      const playing = elements.filter((element) => !element.paused && !element.ended);
      const shown = playing.length > 0 ? playing : elements;
      const video = shown.find((element) => element instanceof HTMLVideoElement);
      return {
        playing: playing.length > 0,
        seconds: Math.max(0, ...shown.map((element) => element.currentTime)),
        elements: elements.length,
        // A blob: source is Media Source Extensions, which the HLS player feeds.
        source: video ? (video.currentSrc.startsWith("blob:") ? "mse" : video.currentSrc ? "file" : "none") : "none",
        size: video ? `${video.videoWidth}x${video.videoHeight}` : null,
      };
    });
    return { ...now, requests: { ...entry.streams } };
  };

  // Screencast frames go to the system ffmpeg as H.264 MP4, the format GitHub plays in every
  // browser. Frames arrive only when the page changes, so the host paces them itself: it writes
  // the latest frame at a constant FPS for the time that has passed, and a still page holds its
  // last frame until the stop. ffmpeg's wallclock timestamps can't do this: they drop a still
  // tail, its `fps` filter pads the last frame by the gap before it, and probing restamps small
  // frames, so clips ran too short or too long.
  const FPS = 30;
  const pump = (recording) => {
    if (!recording.last || recording.ffmpeg.stdin.destroyed) return;
    const due = Math.floor(((performance.now() - recording.started) / 1000) * FPS) + 1;
    for (; recording.written < due; recording.written += 1) recording.ffmpeg.stdin.write(recording.last);
  };

  const startRecording = async (entry, options) => {
    if (entry.recording) throw new Error("this page is already recording");
    const path = output(options, options.path);
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg",
      "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    ffmpeg.stderr.on("data", (chunk) => (errors += chunk));
    // A missing ffmpeg or one that exits early must fail this recording, not crash the host and
    // lose every signed-in page. Its exit code reports a broken pipe, so stdin errors are dropped.
    ffmpeg.stdin.on("error", () => {});
    const done = new Promise((resolveDone, rejectDone) => {
      ffmpeg.on("error", (error) => rejectDone(new Error(`ffmpeg failed to start: ${error.message}`)));
      ffmpeg.on("close", (code) =>
        code === 0 ? resolveDone() : rejectDone(new Error(`ffmpeg exited ${code}: ${errors}`)),
      );
    });
    done.catch(() => {});
    const recording = { path, ffmpeg, done, actions: null, last: null, started: 0, written: 0, timer: null };
    try {
      if (options["show-actions"]) recording.actions = await entry.page.screencast.showActions();
      recording.timer = setInterval(() => pump(recording), 1000 / FPS);
      await entry.page.screencast.start({
        size: entry.viewport,
        quality: 90,
        onFrame: ({ data }) => {
          // The clip starts at the first frame; each later frame replaces the one being held.
          if (!recording.last) recording.started = performance.now();
          pump(recording);
          recording.last = data;
        },
      });
    } catch (error) {
      clearInterval(recording.timer);
      await recording.actions?.[Symbol.asyncDispose]?.();
      ffmpeg.kill();
      throw error;
    }
    entry.recording = recording;
    return `recording to ${path}`;
  };

  const stopRecording = async (entry) => {
    if (!entry.recording) throw new Error("this page is not recording");
    const recording = entry.recording;
    const { path, ffmpeg, done, actions } = recording;
    entry.recording = null;
    await entry.page.screencast.stop();
    await actions?.[Symbol.asyncDispose]?.();
    clearInterval(recording.timer);
    pump(recording);
    ffmpeg.stdin.end();
    await done;
    return path;
  };

  // Posters and backdrops load lazily and decode off the main thread, so a screenshot taken right
  // after a page renders shows their placeholders. Wait until every image the screenshot covers
  // has loaded, decoded, and painted: `<img>` elements and CSS background images, which the app
  // uses for backdrops and stills. For a full-page shot that's every image, so lazy ones below
  // the fold are told to load now; otherwise it's the ones in view, since lazy ones never start.
  const settleImages = async (page, options) => {
    // One function evaluated in the page: a string predicate, as `waitForFunction` polls it, needs
    // the eval that the app's Content-Security-Policy blocks.
    const settled = await page.evaluate(
      async ([full, ms]) => {
        // In view both ways: a row that scrolls sideways puts lazy cards past the right edge, and
        // they never start loading, even in a full-page shot, which grows only downwards.
        const across = (box) => box.right > 0 && box.left < innerWidth;
        const inView = (element) => {
          const box = element.getBoundingClientRect();
          return (
            box.width > 0 && box.height > 0 && across(box) && (full || (box.bottom > 0 && box.top < innerHeight))
          );
        };
        const covered = () =>
          [...document.images].filter((image) => {
            if (full) image.loading = "eager";
            return inView(image);
          });
        const backgrounds = () => {
          const urls = new Set();
          for (const element of document.querySelectorAll("[style*='background-image']")) {
            if (!inView(element)) continue;
            for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)) {
              urls.add(match[1]);
            }
          }
          return [...urls];
        };
        const deadline = Date.now() + ms;
        while (!covered().every((image) => image.complete)) {
          if (Date.now() > deadline) return false;
          await new Promise((done) => setTimeout(done, 100));
        }
        // A background image has no element to wait on, so load each into one; the cache hands
        // the element's paint the same decoded image.
        const loaded = backgrounds().map((url) => {
          const image = new Image();
          image.src = url;
          return image.decode().catch(() => {});
        });
        const timer = new Promise((done) => setTimeout(() => done("timeout"), Math.max(0, deadline - Date.now())));
        if ((await Promise.race([Promise.all(loaded), timer])) === "timeout") return false;
        await Promise.all(covered().map((image) => image.decode().catch(() => {})));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return true;
      },
      [Boolean(options.full), timeout(options)],
    );
    if (!settled) throw new Error("the images in the screenshot did not finish loading");
  };

  // Signed-in pages land on the profile picker, or on a page with the app's main navigation.
  const signedIn = (page) =>
    page
      .getByRole("heading", { name: "Who's watching?" })
      .or(page.getByRole("navigation").first());

  // Picks a profile on /profiles, entering its PIN when it has one, and waits for the app.
  const chooseProfile = async (page, options) => {
    await page.getByRole("heading", { name: "Who's watching?" }).waitFor({ timeout: timeout(options) });
    await page.getByRole("button", { name: options.profile, exact: true }).click();
    // A PIN profile asks for its PIN unless this session already unlocked it, as creating it does.
    // The label names both the digits' group and the first digit, so ask for the textbox. The
    // page doesn't focus it, so click it first, as a person does.
    const pin = page.getByRole("textbox", { name: `${options.profile}'s PIN`, exact: true });
    const left = page.waitForURL((url) => !url.pathname.startsWith("/profiles"), { timeout: timeout(options) });
    if (await Promise.race([left.then(() => false), pin.waitFor({ timeout: timeout(options) }).then(() => true, () => false)])) {
      if (!options.pin) throw new Error(`${options.profile} has a PIN; pass --pin`);
      await pin.click();
      await page.keyboard.type(options.pin);
    }
    await left;
    return `watching as ${options.profile}`;
  };

  // Opens a path the way a person would, getting past the profile picker that a page load can
  // land on: the app forgets nothing, but a fresh tab asks who's watching until one is chosen.
  const visit = async (page, path, options) => {
    await page.goto(path);
    const picker = page.getByRole("heading", { name: "Who's watching?" });
    await picker.or(page.getByRole("main")).first().waitFor({ timeout: timeout(options) });
    if (await picker.isVisible()) {
      if (!options.profile) return;
      await chooseProfile(page, options);
    }
  };

  const commands = {
    async "record-start"(entry, options) {
      return startRecording(entry, options);
    },
    async "record-stop"(entry) {
      return stopRecording(entry);
    },
    async open({ page }, options) {
      await page.goto(options.args[0] ?? "/");
      return page.url();
    },
    async click({ page }, options) {
      await locate(page, options).click({ timeout: timeout(options) });
    },
    async hover({ page }, options) {
      await locate(page, options).hover({ timeout: timeout(options) });
    },
    async fill({ page }, options) {
      await locate(page, options).fill(options.value ?? "", { timeout: timeout(options) });
    },
    async type({ page }, options) {
      await page.keyboard.type(options.value ?? "");
    },
    async press({ page }, options) {
      if (!options.key) throw new Error("press needs --key");
      if (hasLocator(options)) await locate(page, options).press(options.key);
      else await page.keyboard.press(options.key);
    },
    async wait({ page }, options) {
      if (options.url) {
        await page.waitForURL(new RegExp(options.url), { timeout: timeout(options) });
        return page.url();
      }
      await locate(page, options).waitFor({
        state: options.hidden ? "hidden" : "visible",
        timeout: timeout(options),
      });
    },
    async text({ page }, options) {
      return (await locate(page, options).innerText({ timeout: timeout(options) })).trim();
    },
    async count({ page }, options) {
      return String(await locate(page, options).count());
    },
    async attr({ page }, options) {
      if (!options.attr) throw new Error("attr needs --attr");
      return (await locate(page, options).getAttribute(options.attr)) ?? "";
    },
    async snapshot({ page }, options) {
      const target = hasLocator(options) ? locate(page, options) : page.locator("body");
      const tree = await target.ariaSnapshot({ timeout: timeout(options) });
      if (options.path) writeFileSync(output(options, options.path), `${tree}\n`);
      return tree;
    },
    async screenshot({ page }, options) {
      const path = output(options, options.path);
      // An element below the fold scrolls into view first, so its images count as in view. It
      // scrolls to the middle of the window: at an edge, a phone's fixed tab bar covers it.
      if (hasLocator(options)) {
        await locate(page, options).evaluate((element) => element.scrollIntoView({ block: "center" }));
      }
      await settleImages(page, options);
      if (hasLocator(options)) await locate(page, options).screenshot({ path });
      else await page.screenshot({ path, fullPage: options.full });
      return path;
    },
    async video(entry) {
      return JSON.stringify(await media(entry));
    },
    async "wait-video"(entry, options) {
      const start = (await media(entry)).seconds;
      const target =
        options.past !== undefined ? Number(options.past) : start + Number(options.advance ?? 1);
      const deadline = Date.now() + timeout(options);
      for (;;) {
        const now = await media(entry);
        if (now.playing && now.seconds > target) return JSON.stringify(now);
        if (Date.now() > deadline) {
          throw new Error(`video did not play past ${target}s: ${JSON.stringify(now)}`);
        }
        await entry.page.waitForTimeout(250);
      }
    },
    async url({ page }) {
      return page.url();
    },
    async eval({ page }, options) {
      if (!options.js) throw new Error("eval needs --js");
      return JSON.stringify(await page.evaluate(options.js));
    },
    async "sign-in"({ page }, options) {
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(options.email ?? OWNER.email);
      await page.getByLabel("Password", { exact: true }).fill(options.password ?? OWNER.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.waitForURL((url) => url.pathname !== "/sign-in", { timeout: timeout(options) });
      await signedIn(page).first().waitFor({ timeout: timeout(options) });
      if (options.profile) return chooseProfile(page, options);
      return page.url();
    },
    async profile({ page }, options) {
      if (!options.profile) throw new Error("profile needs --profile NAME");
      if (!new URL(page.url()).pathname.startsWith("/profiles")) await page.goto("/profiles");
      return chooseProfile(page, options);
    },
    // First-run setup, as an owner does it on a fresh server: the owner account, the Movies
    // library and its first scan, then the Shows library from Admin, Libraries.
    async setup({ page }, options) {
      const long = Number(options.timeout ?? 900_000);
      await page.goto("/");
      await page.waitForURL(/\/welcome/, { timeout: timeout(options) });
      await page.getByLabel("Your name").fill(OWNER.name);
      await page.getByLabel("Email").fill(OWNER.email);
      await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
      await page.getByRole("button", { name: "Create admin account" }).click();
      await page.waitForURL(/\/setup\/library/, { timeout: timeout(options) });
      await page.getByRole("radio", { name: "Movies" }).click();
      await page.getByLabel("Folder path", { exact: true }).fill(options.movies ?? "/media/library/Movies");
      await page.getByRole("button", { name: "Save and start scan" }).click();
      await page.waitForURL(/\/setup\/scan/, { timeout: timeout(options) });
      await page.getByText("done", { exact: true }).waitFor({ timeout: long });
      await page.getByRole("link", { name: "Continue to [movies]" }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/setup"), { timeout: timeout(options) });
      if (options.shows) {
        await visit(page, "/admin/libraries", { ...options, profile: OWNER.name, pin: undefined });
        await page.getByRole("button", { name: "Add library" }).click();
        const dialog = page.getByRole("dialog", { name: "Add library" });
        await dialog.getByLabel("Name").fill("Shows");
        await dialog.getByRole("radio", { name: "Series" }).click();
        await dialog.getByLabel("Folder 1").fill(options.shows);
        await dialog.getByRole("button", { name: "Add library" }).click();
        await dialog.waitFor({ state: "hidden", timeout: timeout(options) });
      }
      return `set up as ${OWNER.email}`;
    },
    // Adds a profile to the signed-in account from /profiles/new: a kids profile keeps the form's
    // PG limit, and --pin sets a four-digit PIN.
    async "add-profile"({ page }, options) {
      if (!options.profile) throw new Error("add-profile needs --profile NAME");
      await page.goto("/profiles/new");
      await page.getByRole("heading", { name: "Add profile" }).waitFor({ timeout: timeout(options) });
      await page.getByLabel("Name", { exact: true }).fill(options.profile);
      if (options.kids) await page.getByRole("switch", { name: "Kids profile" }).click();
      if (options.pin) {
        await page.getByRole("switch", { name: "Profile PIN" }).click();
        await page.getByRole("textbox", { name: "PIN", exact: true }).click();
        await page.keyboard.type(options.pin);
      }
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("button", { name: options.profile, exact: true }).waitFor({ timeout: timeout(options) });
      return `added ${options.profile}`;
    },
    // Makes an invite link from Admin, Users and prints its code.
    async invite({ page }, options) {
      const role = options["invite-role"] ?? "member";
      await visit(page, "/admin/users", { ...options, profile: options.profile ?? OWNER.name });
      await page.getByRole("heading", { name: "New invite" }).waitFor({ timeout: timeout(options) });
      const section = page.getByRole("region", { name: "New invite" });
      if (await section.getByRole("button", { name: "Create another" }).isVisible()) {
        await section.getByRole("button", { name: "Create another" }).click();
      }
      await section.getByLabel("Role").selectOption(role);
      await section.getByRole("button", { name: "Create invite link" }).click();
      const field = section.getByLabel("Invite link");
      await field.waitFor({ timeout: timeout(options) });
      const link = (await field.inputValue().catch(() => null)) ?? (await field.innerText());
      const code = new URL(link.trim()).pathname.split("/").pop();
      if (!code) throw new Error(`the invite link looks wrong: "${link}"`);
      return code;
    },
    // Accepts an invite at /invite/<code> and makes the account, as the invited person does.
    async join({ page }, options) {
      if (!options.code || !options.name || !options.email) throw new Error("join needs --code, --name, and --email");
      await page.goto(`/invite/${options.code}`);
      await page.getByRole("heading", { name: "You're invited." }).waitFor({ timeout: timeout(options) });
      await page.getByLabel("Your name").fill(options.name);
      const email = page.getByLabel("Email");
      if (await email.isEditable()) await email.fill(options.email);
      await page.getByLabel("Choose a password").fill(options.password ?? OWNER.password);
      await page.getByRole("button", { name: "Accept and create account" }).click();
      await page.waitForURL(/\/profiles/, { timeout: timeout(options) });
      return `joined as ${options.email}`;
    },
  };

  const handle = async (options) => {
    if (options.command === "pages") {
      return [...pages.entries()]
        .map(([name, { page, recording }]) => `${name}\t${page.url()}${recording ? "\trecording" : ""}`)
        .join("\n");
    }
    if (options.command === "close-page") {
      const entry = pages.get(options.page);
      if (!entry) throw new Error(`no page named ${options.page}`);
      pages.delete(options.page);
      const saved = entry.recording ? await stopRecording(entry) : null;
      await entry.context.close();
      return saved ? `closed ${options.page}; saved ${saved}` : `closed ${options.page}`;
    }
    const run = commands[options.command];
    if (!run) throw new Error(`unknown command "${options.command}"`);
    return run(await pageFor(options), options);
  };

  const server = createServer((request, response) => {
    // A JSON content type makes a browser preflight a cross-origin request, which this host never
    // answers, so a web page open elsewhere can't drive the signed-in verification pages.
    if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
      response.writeHead(415).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      let result;
      try {
        result = { ok: true, output: (await handle(JSON.parse(body || "{}"))) ?? "" };
      } catch (error) {
        result = { ok: false, error: error.message.split("\n").slice(0, 12).join("\n") };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const portFile = join(state, "browser.port");
    writeFileSync(`${portFile}.tmp`, String(server.address().port));
    renameSync(`${portFile}.tmp`, portFile);
  });

  const stop = async () => {
    for (const entry of pages.values()) {
      if (entry.recording) await stopRecording(entry).catch(() => {});
      await entry.context.close().catch(() => {});
    }
    await browser.close();
    rmSync(join(state, "browser.port"), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
