/**
 * Configures a [movies] Convex deployment. Safe to run again: secrets that exist are kept.
 *
 *   node scripts/configure.ts [--site-url http://localhost:3001] [--media-url http://127.0.0.1:3002]
 *
 * Without a URL flag, SITE_URL and MEDIA_BASE_URL keep their stored values (or get the local
 * defaults when unset), so rerunning it after a restore does not reset them.
 *
 * Sets JWT_PRIVATE_KEY and JWKS for Convex Auth, SITE_URL, MEDIA_BASE_URL, PLAYBACK_TOKEN_SECRET,
 * and MEDIA_SERVICE_API_KEY; makes sure the media service's account and key exist; then prints
 * `MEDIA_SERVICE_API_KEY=...` and `PLAYBACK_TOKEN_SECRET=...` on stdout for the media service's
 * environment. Everything else goes to stderr. It runs this package's `convex` CLI, so it targets
 * whatever deployment the CLI targets (`.env.local`, or `CONVEX_SELF_HOSTED_*` variables).
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "site-url": { type: "string" },
    "media-url": { type: "string" },
  },
});

const convexBin = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));

const convex = (args: ReadonlyArray<string>): string =>
  execFileSync(convexBin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const log = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const current = new Map(
  convex(["env", "list"])
    .split("\n")
    .flatMap((line) => {
      const separator = line.indexOf("=");

      return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)] as const] : [];
    }),
);

/** Sets a variable unless it already has a value and `keep` asks to keep it; returns the value. */
const ensure = (name: string, value: () => string, keep: boolean): string => {
  const existing = current.get(name);

  if (keep && existing !== undefined && existing.length > 0) {
    log(`kept ${name}`);

    return existing;
  }

  const next = value();
  convex(["env", "set", name, "--", next]);
  current.set(name, next);
  log(`set ${name}`);

  return next;
};

if (!current.has("JWT_PRIVATE_KEY") || !current.has("JWKS")) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = keys.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKey = keys.publicKey.export({ format: "jwk" });

  ensure("JWT_PRIVATE_KEY", () => privateKey.trimEnd().replaceAll("\n", " "), false);
  ensure("JWKS", () => JSON.stringify({ keys: [{ use: "sig", ...publicKey }] }), false);
} else {
  log("kept JWT_PRIVATE_KEY and JWKS");
}

/** A URL flag replaces the stored value; without it the stored value stays, or the default is set. */
const ensureUrl = (name: string, flag: string | undefined, fallback: string): void => {
  ensure(name, () => flag ?? fallback, flag === undefined);
};

ensureUrl("SITE_URL", values["site-url"], "http://localhost:3001");

ensureUrl("MEDIA_BASE_URL", values["media-url"], "http://127.0.0.1:3002");

const playbackSecret = ensure(
  "PLAYBACK_TOKEN_SECRET",
  () => randomBytes(32).toString("base64url"),
  true,
);

const serviceKey = ensure(
  "MEDIA_SERVICE_API_KEY",
  () => `mk_service_${randomBytes(32).toString("base64url")}`,
  true,
);

const ensured = convex([
  "run",
  "setup:ensureServiceKey",
  JSON.stringify({
    hash: createHash("sha256").update(serviceKey).digest("hex"),
    prefix: serviceKey.slice(0, 10),
  }),
]);

log(`media service key: ${ensured.includes("true") ? "registered" : "already registered"}`);

process.stdout.write(
  `MEDIA_SERVICE_API_KEY=${serviceKey}\nPLAYBACK_TOKEN_SECRET=${playbackSecret}\n`,
);
