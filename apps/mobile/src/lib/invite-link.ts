/**
 * Invite links (A01 Open an Invite). The web app's links are `<server>/invite/<code>`; the app's
 * own deep link is `movies://invite?server=<server>&code=<code>`. Both name the media service to
 * connect to and the invite code to redeem there. Parsed with patterns rather than `URL`, whose
 * query support React Native only partly implements.
 */
import { normalizeServerUrl } from "./discovery";

/** The server an invite belongs to and its code. */
export interface InviteLink {
  /** The media service, as `normalizeServerUrl` writes it. */
  readonly mediaUrl: string;
  readonly code: string;
}

const MAX_CODE_LENGTH = 200;

const decode = (text: string): string | null => {
  try {
    return decodeURIComponent(text.replaceAll("+", " "));
  } catch {
    return null;
  }
};

const validCode = (raw: string | null | undefined): string | null => {
  const code = raw === null || raw === undefined ? null : decode(raw)?.trim();

  return code === undefined || code === null || code === "" || code.length > MAX_CODE_LENGTH
    ? null
    : code;
};

/** One query parameter's raw value. */
const queryValue = (query: string, name: string): string | null => {
  for (const pair of query.split("&")) {
    const [key = "", ...rest] = pair.split("=");

    if (decode(key) === name) return rest.join("=");
  }

  return null;
};

const DEEP_LINK = /^movies:\/\/\/?invite(?:\/(?<path>[^?#]*))?(?:\?(?<query>[^#]*))?(?:#.*)?$/iu;

const WEB_LINK =
  /^(?:(?<scheme>https?):\/\/)?(?<base>[^?#\s]+?)\/invite\/(?<code>[^/?#\s]+)\/?(?:[?#].*)?$/iu;

/** `movies://invite?server=…&code=…`, or `movies://invite/<code>?server=…`. */
const parseDeepLink = (text: string): InviteLink | null => {
  const groups = DEEP_LINK.exec(text)?.groups;

  if (groups === undefined) return null;
  const query = groups["query"] ?? "";
  const server = queryValue(query, "server");
  const code = validCode(queryValue(query, "code") ?? groups["path"]);
  const decodedServer = server === null ? null : decode(server);
  const mediaUrl = decodedServer === null ? null : normalizeServerUrl(decodedServer);

  return code === null || mediaUrl === null ? null : { mediaUrl, code };
};

/** `<server>/invite/<code>`, where the server may sit under a path prefix. */
const parseWebLink = (text: string): InviteLink | null => {
  const groups = WEB_LINK.exec(text)?.groups;

  if (groups === undefined) return null;
  const scheme = groups["scheme"];
  const base = groups["base"] ?? "";
  const mediaUrl = normalizeServerUrl(scheme === undefined ? base : `${scheme}://${base}`);
  const code = validCode(groups["code"]);

  return code === null || mediaUrl === null ? null : { mediaUrl, code };
};

/**
 * The invite in a pasted or opened link, or null when the text is not an invite link. Pasted web
 * links may leave out the scheme (`cinema.home/invite/abc`), which then means `https`.
 */
export const parseInviteLink = (text: string): InviteLink | null => {
  const trimmed = text.trim();

  return /^movies:/iu.test(trimmed) ? parseDeepLink(trimmed) : parseWebLink(trimmed);
};

/** Whether two media service addresses name the same server. */
export const sameServer = (left: string, right: string): boolean =>
  normalizeServerUrl(left) === normalizeServerUrl(right);
