/**
 * A tolerant reader for the small XML documents media managers write (Kodi/Jellyfin NFO files).
 * It keeps elements, attributes, and text; it ignores namespaces, processing instructions,
 * comments, and doctypes, and closes unbalanced tags instead of failing.
 */

/** One element with its attributes, child elements, and directly contained text. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: ReadonlyArray<XmlElement>;
  /** Concatenated text and CDATA directly inside the element, with entities decoded. */
  readonly text: string;
}

interface OpenElement {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: Array<XmlElement>;
  text: string;
}

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][\s\S]*?>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;

const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

const decodeEntities = (text: string): string =>
  text.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity: string, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }

    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));

    return NAMED_ENTITIES.get(body.toLowerCase()) ?? entity;
  });

const parseAttributes = (source: string): ReadonlyMap<string, string> => {
  const attributes = new Map<string, string>();

  for (const match of source.matchAll(ATTRIBUTE)) {
    if (match[1] === undefined) continue;
    attributes.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3] ?? match[4] ?? ""));
  }

  return attributes;
};

const close = (element: OpenElement): XmlElement => ({
  name: element.name,
  attributes: element.attributes,
  children: element.children,
  text: element.text,
});

/** Parses `source` into its top-level elements (NFO files for multi-episode files have several). */
export const parseXml = (source: string): ReadonlyArray<XmlElement> => {
  const document: OpenElement = {
    name: "#document",
    attributes: new Map(),
    children: [],
    text: "",
  };

  const stack: Array<OpenElement> = [document];
  const current = (): OpenElement => stack.at(-1) ?? document;

  for (const match of source.replace(/^﻿/, "").matchAll(TOKEN)) {
    const [, cdata, closing, rawName, attributes, selfClosing, text] = match;

    if (cdata !== undefined) {
      current().text += cdata;
    } else if (text !== undefined) {
      current().text += decodeEntities(text);
    } else if (rawName !== undefined) {
      const name = rawName.toLowerCase();

      if (closing === "/") {
        const index = stack.findLastIndex((element) => element.name === name);

        // A stray closing tag is ignored; one that closes an outer element closes the inner ones too.
        if (index > 0) {
          const finished = stack.splice(index);

          finished.forEach((element, position) => {
            (finished[position - 1] ?? current()).children.push(close(element));
          });
        }
      } else {
        const element: OpenElement = {
          name,
          attributes: parseAttributes(attributes ?? ""),
          children: [],
          text: "",
        };

        if (selfClosing === "/") current().children.push(close(element));
        else stack.push(element);
      }
    }
  }

  while (stack.length > 1) {
    const finished = stack.pop();

    if (finished !== undefined) current().children.push(close(finished));
  }

  return document.children;
};

/** The child elements of `element` called `name`. */
export const childrenNamed = (element: XmlElement, name: string): ReadonlyArray<XmlElement> =>
  element.children.filter((child) => child.name === name);

/** The trimmed text of the first child called `name`, or `undefined` when absent or blank. */
export const childText = (element: XmlElement, name: string): string | undefined => {
  const text = childrenNamed(element, name)[0]?.text.trim();

  return text === undefined || text === "" ? undefined : text;
};
