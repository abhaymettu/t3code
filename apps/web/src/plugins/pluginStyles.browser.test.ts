import { describe, expect, it } from "vite-plus/test";

import { applyPluginDocumentStyles, previewPluginRangeSetting } from "./pluginStyles";

function pluginStyleElements() {
  return Array.from(document.head.querySelectorAll<HTMLStyleElement>("style[data-plugin-id]"));
}

describe("applyPluginDocumentStyles", () => {
  it("keeps plugin styles last in head and removes what a plugin no longer contributes", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme-id", "nightfall");
    root.style.setProperty("--app-theme-canvas", "#000");
    using _cleanup = {
      [Symbol.dispose]: () => {
        applyPluginDocumentStyles({ stylesheets: [], attributes: {}, properties: {} });
        root.removeAttribute("data-theme-id");
        root.style.removeProperty("--app-theme-canvas");
      },
    };

    applyPluginDocumentStyles({
      stylesheets: [
        { pluginId: "dev.example.a", css: ".a {}" },
        { pluginId: "dev.example.b", css: ".b {}" },
      ],
      attributes: { "data-plugin-dev_example_a--on": "true" },
      properties: { "--plugin-dev_example_a--size": "4px" },
    });
    const [first] = pluginStyleElements();
    const appStyle = document.createElement("style");
    document.head.append(appStyle);
    using _appStyle = { [Symbol.dispose]: () => appStyle.remove() };

    applyPluginDocumentStyles({
      stylesheets: [{ pluginId: "dev.example.a", css: ".a { color: red; }" }],
      attributes: {},
      properties: { "--plugin-dev_example_a--size": "8px" },
    });

    expect(pluginStyleElements().map((element) => element.textContent)).toEqual([
      ".a { color: red; }",
    ]);
    expect(pluginStyleElements()[0]).toBe(first);
    expect(document.head.lastElementChild).toBe(first);
    expect(root.hasAttribute("data-plugin-dev_example_a--on")).toBe(false);
    expect(root.style.getPropertyValue("--plugin-dev_example_a--size")).toBe("8px");
    expect(root.getAttribute("data-theme-id")).toBe("nightfall");

    const size = {
      type: "range",
      key: "size",
      title: "Size",
      min: 0,
      max: 20,
      step: 1,
      unit: "px",
      default: 4,
    } as const;
    previewPluginRangeSetting("dev.example.a", size, 12);
    expect(root.style.getPropertyValue("--plugin-dev_example_a--size")).toBe("12px");
    applyPluginDocumentStyles({
      stylesheets: [],
      attributes: {},
      properties: { "--plugin-dev_example_a--size": "8px" },
    });
    expect(root.style.getPropertyValue("--plugin-dev_example_a--size")).toBe("8px");
    expect(root.style.getPropertyValue("--app-theme-canvas")).toBe("#000");
  });
});
