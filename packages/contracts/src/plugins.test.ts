import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PLUGIN_MANIFEST_PARSE_OPTIONS,
  PluginManifest,
  type PluginSettingDefinition,
  pluginCssName,
  pluginCssPrefix,
  resolvePluginSettingValue,
} from "./plugins.ts";

const decodeManifest = Schema.decodeUnknownSync(PluginManifest, PLUGIN_MANIFEST_PARSE_OPTIONS);

const manifest = {
  manifestVersion: 1,
  id: "dev.example.glass",
  version: "1.2.0",
  apiVersion: 1,
  name: "Glass",
  contributes: {
    styles: ["./glass.css"],
    settings: [
      { type: "boolean", key: "sidebar", title: "Sidebar", default: true },
      {
        type: "select",
        key: "tint",
        title: "Tint",
        options: [
          { value: "cool", label: "Cool" },
          { value: "warm", label: "Warm" },
        ],
        default: "cool",
      },
      {
        type: "range",
        key: "blur",
        title: "Blur",
        min: 0,
        max: 40,
        step: 2,
        unit: "px",
        default: 12,
      },
    ],
  },
};

describe("PluginManifest", () => {
  it("decodes a declarative manifest", () => {
    expect(decodeManifest(manifest).contributes.settings?.map((setting) => setting.key)).toEqual([
      "sidebar",
      "tint",
      "blur",
    ]);
  });

  it.each([
    ["an id without a namespace", { ...manifest, id: "glass" }],
    ["an id with a double dash", { ...manifest, id: "dev.example--glass" }],
    ["an id segment ending in a dash", { ...manifest, id: "dev-.example.glass" }],
    ["an id with an underscore", { ...manifest, id: "dev.example_glass" }],
    [
      "a setting key with a double dash",
      {
        ...manifest,
        contributes: { settings: [{ type: "boolean", key: "a--b", title: "A", default: true }] },
      },
    ],
    ["an executable entrypoint", { ...manifest, entrypoints: { web: "./index.js" } }],
    [
      "a stylesheet outside the folder",
      { ...manifest, contributes: { styles: ["./a/../../x.css"] } },
    ],
    ["a stylesheet that is not css", { ...manifest, contributes: { styles: ["./glass.js"] } }],
    [
      "a select default that is not an option",
      {
        ...manifest,
        contributes: {
          settings: [
            {
              type: "select",
              key: "tint",
              title: "Tint",
              options: [
                { value: "cool", label: "Cool" },
                { value: "warm", label: "Warm" },
              ],
              default: "hot",
            },
          ],
        },
      },
    ],
    [
      "a range default outside its bounds",
      {
        ...manifest,
        contributes: {
          settings: [
            { type: "range", key: "blur", title: "Blur", min: 0, max: 4, step: 1, default: 9 },
          ],
        },
      },
    ],
    [
      "duplicate setting keys",
      {
        ...manifest,
        contributes: {
          settings: [
            { type: "boolean", key: "a", title: "A", default: true },
            { type: "boolean", key: "a", title: "A again", default: false },
          ],
        },
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => decodeManifest(input)).toThrow();
  });
});

describe("resolvePluginSettingValue", () => {
  const settings = decodeManifest(manifest).contributes
    .settings as ReadonlyArray<PluginSettingDefinition>;
  const [sidebar, tint, blur] = settings as [
    PluginSettingDefinition,
    PluginSettingDefinition,
    PluginSettingDefinition,
  ];

  it.each([
    [sidebar, false, false],
    [sidebar, "yes", true],
    [tint, "warm", "warm"],
    [tint, "hot", "cool"],
    [blur, 20, 20],
    [blur, 41, 12],
    [blur, undefined, 12],
  ] as const)("resolves %o with stored %o to %o", (setting, stored, expected) => {
    expect(resolvePluginSettingValue(setting, stored)).toBe(expected);
  });
});

describe("pluginCssName", () => {
  it("never gives two plugins or a plugin and a setting the same name", () => {
    expect([
      pluginCssPrefix("a.b-c"),
      pluginCssPrefix("a-b.c"),
      pluginCssName("a.b", "c"),
      pluginCssPrefix("a.b-c-d"),
      pluginCssName("a.b-c", "d"),
    ]).toEqual([
      "plugin-a_b-c",
      "plugin-a-b_c",
      "plugin-a_b--c",
      "plugin-a_b-c-d",
      "plugin-a_b-c--d",
    ]);
  });
});
