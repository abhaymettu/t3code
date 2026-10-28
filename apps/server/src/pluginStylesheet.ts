import * as Result from "effect/Result";

const EMBEDDABLE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  woff2: "font/woff2",
};

const EMBEDDABLE_DATA_URL = /^data:(?:image\/(?:png|jpeg|webp|gif|avif)|font\/woff2)(?:;base64)?,/i;
const PLUGIN_FILE_PATH = /^[A-Za-z0-9_./-]+$/;
const HEX_DIGIT = /[0-9a-fA-F]/;
const WHITESPACE = /[ \t\n]/;

interface Identifier {
  readonly name: string;
  readonly end: number;
}

/**
 * Non-ASCII code points end an identifier here, though CSS may continue one through them.
 * Splitting more often can only reveal extra function names, never hide one.
 */
const isIdentifierChar = (char: string) => /[A-Za-z0-9_-]/.test(char);

const skipWhitespace = (css: string, start: number) => {
  let index = start;
  while (index < css.length && WHITESPACE.test(css[index]!)) index += 1;
  return index;
};

const isValidEscape = (css: string, index: number) =>
  css[index] === "\\" && index + 1 < css.length && css[index + 1] !== "\n";

/** Reads the escape at a valid `\`: up to six hex digits and one whitespace, or one code point. */
const readEscape = (
  css: string,
  start: number,
): { readonly char: string; readonly end: number } => {
  let cursor = start + 1;
  let hex = "";
  while (hex.length < 6 && cursor < css.length && HEX_DIGIT.test(css[cursor]!)) {
    hex += css[cursor];
    cursor += 1;
  }
  if (hex.length === 0) {
    const char = String.fromCodePoint(css.codePointAt(cursor)!);
    return { char, end: cursor + char.length };
  }
  if (cursor < css.length && WHITESPACE.test(css[cursor]!)) cursor += 1;
  const codePoint = Number.parseInt(hex, 16);
  const valid =
    codePoint !== 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return { char: valid ? String.fromCodePoint(codePoint) : "\uFFFD", end: cursor };
};

/** An unescaped newline or the end of input ends the string unclosed, which CSS treats as invalid. */
const skipString = (
  css: string,
  start: number,
): { readonly end: number; readonly closed: boolean } => {
  const quote = css[start];
  let index = start + 1;
  while (index < css.length) {
    const char = css[index];
    if (char === quote) return { end: index + 1, closed: true };
    if (char === "\n") return { end: index, closed: false };
    if (char !== "\\") index += 1;
    else if (isValidEscape(css, index)) index = readEscape(css, index).end;
    // A backslash before a newline continues the string.
    else index += 2;
  }
  return { end: index, closed: false };
};

/** Unescapes as CSS does, so `u\72l(` and `@\69mport` are seen for what they are. */
const readIdentifier = (css: string, start: number): Identifier => {
  let name = "";
  let index = start;
  while (index < css.length) {
    if (isValidEscape(css, index)) {
      const escape = readEscape(css, index);
      name += escape.char;
      index = escape.end;
    } else if (isIdentifierChar(css[index]!)) {
      name += css[index];
      index += 1;
    } else {
      break;
    }
  }
  return { name: name.toLowerCase(), end: index };
};

/** The `)` closing an unquoted `url(`; an escaped `)` does not close it. */
const findUrlEnd = (css: string, start: number) => {
  let index = start;
  while (index < css.length && css[index] !== ")") {
    index = isValidEscape(css, index) ? readEscape(css, index).end : index + 1;
  }
  return index < css.length ? index : -1;
};

const quoteUrl = (value: string) =>
  value.length > 120 ? `url(${value.slice(0, 120)}...)` : `url(${value})`;

/** Returns the folder-relative path, or null when the reference leaves the folder. */
const resolveInsideFolder = (stylesheetPath: string, reference: string): string | null => {
  const segments = stylesheetPath.split("/").slice(0, -1);
  for (const segment of reference.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const popped = segments.pop();
      if (popped === undefined || popped === ".") return null;
      continue;
    }
    segments.push(segment);
  }
  return segments.filter((segment) => segment !== ".").join("/");
};

const inlineUrl = (
  value: string,
  stylesheetPath: string,
  readFile: (path: string) => Result.Result<Uint8Array, string>,
): Result.Result<string, string> => {
  if (!PLUGIN_FILE_PATH.test(value) || value.startsWith("/")) {
    return Result.fail(`${quoteUrl(value)} must be a data: URL or a file in the plugin folder.`);
  }
  const path = resolveInsideFolder(stylesheetPath, value);
  if (path === null) return Result.fail(`${quoteUrl(value)} points outside the plugin folder.`);
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const mimeType = path.includes(".") ? EMBEDDABLE_MIME_TYPES[extension] : undefined;
  if (mimeType === undefined) {
    return Result.fail(
      `${quoteUrl(value)} is not a file type plugins can embed. Use png, jpg, webp, gif, avif or woff2.`,
    );
  }
  return Result.map(
    readFile(path),
    (bytes) => `url("data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}")`,
  );
};

/**
 * Returns the stylesheet with every relative `url()` replaced by a `data:` URL of the file it names,
 * or a problem when the stylesheet could load anything from outside its plugin folder.
 * `readFile` receives a path relative to the plugin folder, without a leading `./`.
 */
export const inlinePluginStylesheet = (
  source: string,
  stylesheetPath: string,
  readFile: (path: string) => Result.Result<Uint8Array, string>,
): Result.Result<string, string> => {
  // Browsers normalize before tokenizing; scanning and publishing the same text keeps both readings equal.
  const css = source.replace(/\r\n?|\f/g, "\n").replaceAll("\0", "\uFFFD");
  let output = "";
  let copiedUntil = 0;
  let index = 0;
  while (index < css.length) {
    const char = css[index]!;
    if (char === "/" && css[index + 1] === "*") {
      const end = css.indexOf("*/", index + 2);
      index = end === -1 ? css.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(css, index).end;
      continue;
    }
    // `<!--` is one token, so a name right after it starts fresh instead of continuing `--`.
    if (css.startsWith("<!--", index)) {
      index += 4;
      continue;
    }
    if (char === "@") {
      const atRule = readIdentifier(css, index + 1);
      if (atRule.name === "import") return Result.fail("@import is not allowed.");
      index = Math.max(atRule.end, index + 1);
      continue;
    }
    const identifier = readIdentifier(css, index);
    if (identifier.end === index) {
      index += 1;
      continue;
    }
    if (css[identifier.end] !== "(") {
      index = identifier.end;
      continue;
    }
    if (identifier.name === "src" || identifier.name.endsWith("image-set")) {
      return Result.fail(`${identifier.name}() is not allowed. Use url() instead.`);
    }
    if (identifier.name !== "url") {
      index = identifier.end + 1;
      continue;
    }

    let cursor = skipWhitespace(css, identifier.end + 1);
    let value: string;
    if (css[cursor] === '"' || css[cursor] === "'") {
      const string = skipString(css, cursor);
      if (!string.closed)
        return Result.fail(`${quoteUrl(css.slice(cursor, string.end))} is malformed.`);
      value = css.slice(cursor + 1, string.end - 1);
      cursor = skipWhitespace(css, string.end);
    } else {
      const close = findUrlEnd(css, cursor);
      value = css.slice(cursor, close === -1 ? css.length : close).trimEnd();
      cursor = close === -1 ? css.length : close;
    }
    if (css[cursor] !== ")" || value.length === 0) {
      return Result.fail(`${quoteUrl(value)} is malformed.`);
    }
    // SVG and XML documents can fetch from inside a filter, mask or clip-path in Firefox.
    if (/^data:/i.test(value)) {
      if (!EMBEDDABLE_DATA_URL.test(value)) {
        return Result.fail(
          `${quoteUrl(value)} must embed a png, jpeg, webp, gif, avif or woff2 file.`,
        );
      }
      index = cursor + 1;
      continue;
    }
    const inlined = inlineUrl(value, stylesheetPath, readFile);
    if (Result.isFailure(inlined)) return inlined;
    output += css.slice(copiedUntil, index) + inlined.success;
    copiedUntil = cursor + 1;
    index = cursor + 1;
  }
  return Result.succeed(output + css.slice(copiedUntil));
};
