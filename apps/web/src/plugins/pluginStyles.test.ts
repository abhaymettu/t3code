import type { EnvironmentPlugins } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePluginDocumentStyles } from "./pluginStyles";

const ENVIRONMENT: EnvironmentPlugins = {
  plugins: [
    {
      id: "dev.example.backdrop",
      name: "Backdrop",
      version: "1.0.0",
      settings: [
        {
          type: "range",
          key: "opacity",
          title: "Visibility",
          min: 0,
          max: 100,
          step: 5,
          unit: "%",
          default: 60,
        },
        { type: "range", key: "scale", title: "Scale", min: 1, max: 3, step: 0.5, default: 1 },
        { type: "boolean", key: "sidebar", title: "Behind the sidebar", default: false },
        {
          type: "select",
          key: "fit",
          title: "Fit",
          options: [
            { value: "cover", label: "Fill" },
            { value: "contain", label: "Fit" },
          ],
          default: "cover",
        },
      ],
      stylesheet: "body { background: red; }",
    },
    {
      id: "dev.example.quiet",
      name: "Quiet",
      version: "0.1.0",
      settings: [{ type: "boolean", key: "on", title: "On", default: true }],
      stylesheet: ".quiet { display: none; }",
    },
    {
      id: "dev.example.toggles",
      name: "Toggles",
      version: "0.1.0",
      settings: [{ type: "boolean", key: "on", title: "On", default: true }],
      stylesheet: "",
    },
    {
      id: "dev.example.broken",
      name: "Broken",
      version: "0.1.0",
      settings: [{ type: "boolean", key: "on", title: "On", default: true }],
    },
  ],
  problems: [],
};

describe("resolvePluginDocumentStyles", () => {
  it("names every setting of an enabled plugin and falls back to defaults for stale values", () => {
    expect(
      resolvePluginDocumentStyles(ENVIRONMENT, {
        "dev.example.backdrop": {
          enabled: true,
          values: { opacity: 35, scale: 9, sidebar: true, fit: "stretch" },
        },
      }),
    ).toEqual({
      stylesheets: [{ pluginId: "dev.example.backdrop", css: "body { background: red; }" }],
      attributes: {
        "data-plugin-dev_example_backdrop": "",
        "data-plugin-dev_example_backdrop--sidebar": "true",
        "data-plugin-dev_example_backdrop--fit": "cover",
      },
      properties: {
        "--plugin-dev_example_backdrop--opacity": "35%",
        "--plugin-dev_example_backdrop--scale": "1",
        "--plugin-dev_example_backdrop--sidebar": "1",
        "--plugin-dev_example_backdrop--fit": "cover",
      },
    });
  });

  it("applies a settings-only plugin and nothing from one whose stylesheet the server rejected", () => {
    expect(
      resolvePluginDocumentStyles(ENVIRONMENT, {
        "dev.example.toggles": { enabled: true, values: { on: false } },
        "dev.example.broken": { enabled: true, values: {} },
      }),
    ).toEqual({
      stylesheets: [{ pluginId: "dev.example.toggles", css: "" }],
      attributes: {
        "data-plugin-dev_example_toggles": "",
        "data-plugin-dev_example_toggles--on": "false",
      },
      properties: { "--plugin-dev_example_toggles--on": "0" },
    });
  });

  it("leaves out disabled and unconfigured plugins even while their CSS is still published", () => {
    expect(
      resolvePluginDocumentStyles(ENVIRONMENT, {
        "dev.example.backdrop": { enabled: false, values: {} },
      }),
    ).toEqual({ stylesheets: [], attributes: {}, properties: {} });
  });
});
