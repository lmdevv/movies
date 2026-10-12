/**
 * A stand-in for the media service's artwork route during end-to-end runs and screenshots:
 * `GET /artwork/<kind>/<name>.svg` answers a gradient with the title lettered on it, colored from
 * the name, so pages show artwork without a real library.
 *
 *   node e2e/stack/fake-media.ts <port>
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? "4300");

/** Hue pairs that read like film posters: warm sand, steel blue, wine, olive, plum, teal. */
const PALETTES: ReadonlyArray<readonly [string, string]> = [
  ["#c3a07c", "#4f3d2d"],
  ["#4b6584", "#141d2b"],
  ["#8e3b46", "#2b1317"],
  ["#76875a", "#2a331f"],
  ["#b8899c", "#4a3342"],
  ["#4f7f7c", "#1c3133"],
  ["#c06a3e", "#3d1d12"],
  ["#9ea3aa", "#3c4046"],
];

const hash = (text: string): number =>
  Array.from({ length: text.length }, (_, index) => text.charCodeAt(index)).reduce(
    (value, code) => (value * 31 + code) >>> 0,
    7,
  );

const escape = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const svg = (kind: string, name: string): string => {
  const [from, to] = PALETTES[hash(name) % PALETTES.length] ?? ["#444", "#111"];
  const poster = kind === "poster";
  const [width, height] = poster ? [400, 600] : [1600, 900];
  const words = name.replaceAll("-", " ").toUpperCase();

  const lettering =
    kind === "still"
      ? ""
      : `<text x="${poster ? 28 : 120}" y="${poster ? 560 : 820}" font-family="Inter Tight, Helvetica, Arial, sans-serif" font-size="${poster ? 44 : 64}" font-weight="900" letter-spacing="-1.5" fill="#ffffff" fill-opacity="${poster ? 0.95 : 0.12}">${escape(words)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#g)"/>${lettering}</svg>`;
};

createServer((request, response) => {
  const match = /^\/artwork\/(poster|backdrop|still)\/([^/]+)\.svg$/u.exec(request.url ?? "");

  if (match === null) {
    response.writeHead(404).end();

    return;
  }

  const [, kind = "poster", name = ""] = match;

  response
    .writeHead(200, { "content-type": "image/svg+xml", "cache-control": "max-age=3600" })
    .end(svg(kind, kind === "still" ? name.replace(/-\d+-\d+$/u, "") : name));
}).listen(port, "127.0.0.1");
