import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { inlinePluginStylesheet } from "./pluginStylesheet.ts";

const FILES: Readonly<Record<string, string>> = {
  "bg.png": "png",
  "images/bg.PNG": "png",
  "fonts/inter.woff2": "font",
  "mask.png": "PNG",
};

const readFile = (path: string) => {
  const contents = FILES[path];
  return contents === undefined
    ? Result.fail(`${path} is missing.`)
    : Result.succeed(new TextEncoder().encode(contents));
};

const inline = (css: string, stylesheetPath = "./style.css") =>
  inlinePluginStylesheet(css, stylesheetPath, readFile);

describe("inlinePluginStylesheet", () => {
  it.each([
    ["a { color: red; }", "a { color: red; }"],
    ['a { background: url("./bg.png"); }', 'a { background: url("data:image/png;base64,cG5n"); }'],
    ["a { background: URL( bg.png ); }", 'a { background: url("data:image/png;base64,cG5n"); }'],
    [
      "a { background: url('images/bg.PNG') }",
      'a { background: url("data:image/png;base64,cG5n") }',
    ],
    [
      "@font-face { src: url(fonts/inter.woff2) format('woff2'); }",
      "@font-face { src: url(\"data:font/woff2;base64,Zm9udA==\") format('woff2'); }",
    ],
    ["a { mask: url(mask.png); }", 'a { mask: url("data:image/png;base64,UE5H"); }'],
    [
      'a { background: url("data:image/png;base64,UE5H(") url(DATA:font/woff2,x); }',
      'a { background: url("data:image/png;base64,UE5H(") url(DATA:font/woff2,x); }',
    ],
    [
      '/* @import url(http://x) */ a { content: "@import"; }',
      '/* @import url(http://x) */ a { content: "@import"; }',
    ],
    ["a { --myurl: myurl(x); }", "a { --myurl: myurl(x); }"],
    ["a {\r\n  color: red;\f}\r\0", "a {\n  color: red;\n}\n\uFFFD"],
    ['a { content: "\\\r\nx"; }', 'a { content: "\\\nx"; }'],
  ])("publishes %j", (css, expected) => {
    expect(inline(css)).toEqual(Result.succeed(expected));
  });

  it("resolves a url against the stylesheet's own folder", () => {
    expect(inline("a { background: url(../bg.png); }", "./styles/main.css")).toEqual(
      Result.succeed('a { background: url("data:image/png;base64,cG5n"); }'),
    );
  });

  it.each([
    ['@import "other.css";', "@import is not allowed."],
    ["@IMPORT url(other.css);", "@import is not allowed."],
    ["@\\69mport url(other.css);", "@import is not allowed."],
    [
      "a { background: url(https://example.com/bg.png); }",
      "url(https://example.com/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    [
      "a { background: url(http://example.com/bg.png); }",
      "url(http://example.com/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    [
      "a { background: url(//example.com/bg.png); }",
      "url(//example.com/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    [
      "a { background: url(/etc/bg.png); }",
      "url(/etc/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    [
      "a { background: u\\72l(https://example.com/bg.png); }",
      "url(https://example.com/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    [
      'a { background: url("\\68ttps://example.com/bg.png"); }',
      "url(\\68ttps://example.com/bg.png) must be a data: URL or a file in the plugin folder.",
    ],
    ["a { background: url(../bg.png); }", "url(../bg.png) points outside the plugin folder."],
    [
      "a { background: url(images/../../bg.png); }",
      "url(images/../../bg.png) points outside the plugin folder.",
    ],
    [
      "a { background: url(notes.txt); }",
      "url(notes.txt) is not a file type plugins can embed. Use png, jpg, webp, gif, avif or woff2.",
    ],
    ["a { background: url(missing.png); }", "missing.png is missing."],
    ["a { background: url(bg.png; }", "url(bg.png; }) is malformed."],
    ['a { background: image-set("bg.png" 1x); }', "image-set() is not allowed. Use url() instead."],
    [
      'a { background: -webkit-image-set("bg.png" 1x); }',
      "-webkit-image-set() is not allowed. Use url() instead.",
    ],
    ['a { background: src("bg.png"); }', "src() is not allowed. Use url() instead."],
    ...[
      'a { content: "\r} b { background: url(https://example.com/x.png) } c { content: "; }',
      'a { content: "\f} b { background: url(https://example.com/x.png) } c { content: "; }',
      'a { content: "\\\r\n"} b { background: url(https://example.com/x.png) } c { content: "}',
      'a { content: "\\41\n"; background: url(https://example.com/x.png); b: "x" }',
      "a { background: \\75\r\nrl(https://example.com/x.png); }",
      'a { background: url(data:image/png,x\\)"  ); b { background: url(https://example.com/x.png) } c { content: "}',
      "a { background: \u00d7url(https://example.com/x.png); }",
      'a { background: <!--url("https://example.com/x.png"); }',
    ].map((css) => [
      css,
      "url(https://example.com/x.png) must be a data: URL or a file in the plugin folder.",
    ]),
    [
      '<!--url(x"){} a { background: url(https://example.com/x.png) } b { c: "}',
      'url(x") must be a data: URL or a file in the plugin folder.',
    ],
    [
      "a { mask: url(icon.svg); }",
      "url(icon.svg) is not a file type plugins can embed. Use png, jpg, webp, gif, avif or woff2.",
    ],
    ...[
      "data:image/svg+xml;utf8,<svg/>",
      "DATA:IMAGE/SVG+XML,<svg/>",
      "data:application/xml,<svg/>",
      "data:,x",
      "data:image/sv\\67+xml,<svg/>",
    ].map((url) => [
      `a { filter: url("${url}#f"); }`,
      `url(${url}#f) must embed a png, jpeg, webp, gif, avif or woff2 file.`,
    ]),
    ['@\\69\r\nmport "other.css";', "@import is not allowed."],
    ['a { background: url("bg.png\n); }', 'url("bg.png) is malformed.'],
  ])("rejects %j", (css, message) => {
    expect(inline(css)).toEqual(Result.fail(message));
  });
});
