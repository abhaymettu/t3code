import {
  pluginCssName,
  pluginCssPrefix,
  resolvePluginSettingValue,
  type EnvironmentPlugins,
  type PluginId,
  type PluginRangeSetting,
  type ServerSettings,
} from "@t3tools/contracts";

export interface PluginDocumentStyles {
  readonly stylesheets: ReadonlyArray<{ readonly pluginId: PluginId; readonly css: string }>;
  readonly attributes: Readonly<Record<string, string>>;
  readonly properties: Readonly<Record<string, string>>;
}

const pluginRangeProperty = (setting: PluginRangeSetting, value: number) =>
  `${value}${setting.unit ?? ""}`;

export function resolvePluginDocumentStyles(
  environment: EnvironmentPlugins,
  states: ServerSettings["plugins"],
): PluginDocumentStyles {
  const stylesheets: Array<PluginDocumentStyles["stylesheets"][number]> = [];
  const attributes: Record<string, string> = {};
  const properties: Record<string, string> = {};
  for (const plugin of environment.plugins) {
    const state = states[plugin.id];
    // The settings stream can land before the plugins stream withdraws the CSS.
    if (state?.enabled !== true) continue;
    // Enabled without a stylesheet means the server rejected it (or has not sent it yet).
    if (plugin.stylesheet === undefined) continue;
    attributes[`data-${pluginCssPrefix(plugin.id)}`] = "";
    stylesheets.push({ pluginId: plugin.id, css: plugin.stylesheet });
    for (const setting of plugin.settings) {
      const name = pluginCssName(plugin.id, setting.key);
      const value = resolvePluginSettingValue(setting, state.values[setting.key]);
      switch (setting.type) {
        case "boolean":
          properties[`--${name}`] = value === true ? "1" : "0";
          attributes[`data-${name}`] = value === true ? "true" : "false";
          break;
        case "select":
          properties[`--${name}`] = String(value);
          attributes[`data-${name}`] = String(value);
          break;
        case "range":
          properties[`--${name}`] = pluginRangeProperty(setting, Number(value));
          break;
      }
    }
  }
  return { stylesheets, attributes, properties };
}

const ATTRIBUTE_PREFIX = "data-plugin-";
const PROPERTY_PREFIX = "--plugin-";

/** Touches only plugin-owned names, so it can run on every change without disturbing themes. */
export function applyPluginDocumentStyles(styles: PluginDocumentStyles, doc = document): void {
  const root = doc.documentElement;
  for (const name of root.getAttributeNames()) {
    if (name.startsWith(ATTRIBUTE_PREFIX) && !Object.hasOwn(styles.attributes, name)) {
      root.removeAttribute(name);
    }
  }
  for (const [name, value] of Object.entries(styles.attributes)) {
    if (root.getAttribute(name) !== value) root.setAttribute(name, value);
  }
  for (const name of Array.from(root.style)) {
    if (name.startsWith(PROPERTY_PREFIX) && !Object.hasOwn(styles.properties, name)) {
      root.style.removeProperty(name);
    }
  }
  for (const [name, value] of Object.entries(styles.properties)) {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  }

  const existing = new Map(
    Array.from(doc.head.querySelectorAll<HTMLStyleElement>("style[data-plugin-id]"), (element) => [
      element.dataset.pluginId,
      element,
    ]),
  );
  const elements = styles.stylesheets.map(({ pluginId, css }) => {
    const element = existing.get(pluginId) ?? doc.createElement("style");
    existing.delete(pluginId);
    element.dataset.pluginId = pluginId;
    if (element.textContent !== css) element.textContent = css;
    return element;
  });
  for (const stale of existing.values()) stale.remove();
  // Last in <head> so plugin rules win ties against the app's own stylesheets.
  const tailStart = doc.head.children.length - elements.length;
  if (elements.some((element, index) => doc.head.children[tailStart + index] !== element)) {
    doc.head.append(...elements);
  }
}

/** Shows an unsaved slider value at once; the next applied styles replace it with the saved one. */
export function previewPluginRangeSetting(
  pluginId: PluginId,
  setting: PluginRangeSetting,
  value: number,
  doc = document,
): void {
  doc.documentElement.style.setProperty(
    `--${pluginCssName(pluginId, setting.key)}`,
    pluginRangeProperty(setting, value),
  );
}
