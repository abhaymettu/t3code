import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PLUGIN_MANIFEST_FILE_NAME = "t3-plugin.json";
const MAX_PLUGIN_STYLES = 8;
const MAX_PLUGIN_SETTINGS = 32;
const MAX_PLUGIN_SELECT_OPTIONS = 24;

/** No `_` and no `--`, so the CSS names built from ids and keys can never collide. */
export const PluginId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/),
  Schema.isMaxLength(128),
);
export type PluginId = typeof PluginId.Type;

export const PluginSettingKey = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.isMaxLength(48),
);
export type PluginSettingKey = typeof PluginSettingKey.Type;

const SemanticVersion = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/),
  Schema.isMaxLength(64),
);

/** A `./`-relative path inside the plugin folder; `..` segments cannot escape it. */
const PluginStylesheetPath = Schema.String.check(
  Schema.isPattern(/^\.\/(?!(?:.*\/)?\.\.(?:\/|$))[A-Za-z0-9_./-]+\.css$/),
  Schema.isMaxLength(255),
);

const settingFields = {
  key: PluginSettingKey,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(280))),
};

export const PluginBooleanSetting = Schema.Struct({
  type: Schema.Literal("boolean"),
  ...settingFields,
  default: Schema.Boolean,
});
export type PluginBooleanSetting = typeof PluginBooleanSetting.Type;

export const PluginSelectOption = Schema.Struct({
  value: PluginSettingKey,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type PluginSelectOption = typeof PluginSelectOption.Type;

export const PluginSelectSetting = Schema.Struct({
  type: Schema.Literal("select"),
  ...settingFields,
  options: Schema.Array(PluginSelectOption).check(
    Schema.isMinLength(2),
    Schema.isMaxLength(MAX_PLUGIN_SELECT_OPTIONS),
  ),
  default: PluginSettingKey,
}).check(
  Schema.makeFilter(
    (setting) => setting.options.some((option) => option.value === setting.default),
    {
      message: "default must be one of the option values",
    },
  ),
);
export type PluginSelectSetting = typeof PluginSelectSetting.Type;

export const PluginRangeUnit = Schema.Literals(["", "%", "px", "ms", "deg"]);
export type PluginRangeUnit = typeof PluginRangeUnit.Type;

export const PluginRangeSetting = Schema.Struct({
  type: Schema.Literal("range"),
  ...settingFields,
  min: Schema.Finite,
  max: Schema.Finite,
  step: Schema.Finite.check(Schema.isGreaterThan(0)),
  unit: Schema.optional(PluginRangeUnit),
  default: Schema.Finite,
}).check(
  Schema.makeFilter(
    (setting) =>
      setting.min < setting.max && setting.default >= setting.min && setting.default <= setting.max,
    { message: "range needs min < max and a default between them" },
  ),
);
export type PluginRangeSetting = typeof PluginRangeSetting.Type;

export const PluginSettingDefinition = Schema.Union([
  PluginBooleanSetting,
  PluginSelectSetting,
  PluginRangeSetting,
]);
export type PluginSettingDefinition = typeof PluginSettingDefinition.Type;

/** Decode with `PLUGIN_MANIFEST_PARSE_OPTIONS` so a manifest asking for more than this host offers fails loudly. */
export const PLUGIN_MANIFEST_PARSE_OPTIONS = { onExcessProperty: "error" } as const;

export const PluginManifest = Schema.Struct({
  manifestVersion: Schema.Literal(1),
  id: PluginId,
  version: SemanticVersion,
  apiVersion: Schema.Literal(1),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(280))),
  contributes: Schema.Struct({
    styles: Schema.optional(
      Schema.Array(PluginStylesheetPath).check(Schema.isMaxLength(MAX_PLUGIN_STYLES)),
    ),
    settings: Schema.optional(
      Schema.Array(PluginSettingDefinition).check(Schema.isMaxLength(MAX_PLUGIN_SETTINGS)),
    ),
  }),
}).check(
  Schema.makeFilter(
    (manifest) => {
      const keys = (manifest.contributes.settings ?? []).map((setting) => setting.key);
      return new Set(keys).size === keys.length;
    },
    { message: "setting keys must be unique" },
  ),
);
export type PluginManifest = typeof PluginManifest.Type;

export const PluginSettingValue = Schema.Union([Schema.Boolean, Schema.String, Schema.Finite]);
export type PluginSettingValue = typeof PluginSettingValue.Type;

/** Per-environment choice for one installed plugin. Values for unknown or retyped keys are ignored. */
export const PluginState = Schema.Struct({
  enabled: Schema.Boolean,
  values: Schema.Record(PluginSettingKey, PluginSettingValue).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type PluginState = typeof PluginState.Type;

/** Merged into the stored state key by key; a null value removes that value. */
export const PluginStatePatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  values: Schema.optionalKey(Schema.Record(PluginSettingKey, Schema.NullOr(PluginSettingValue))),
});
export type PluginStatePatch = typeof PluginStatePatch.Type;

export const EnvironmentPlugin = Schema.Struct({
  id: PluginId,
  name: TrimmedNonEmptyString,
  version: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  settings: Schema.Array(PluginSettingDefinition),
  /** Sent only while the plugin is enabled, with its folder's files inlined. */
  stylesheet: Schema.optional(Schema.String),
});
export type EnvironmentPlugin = typeof EnvironmentPlugin.Type;

export const EnvironmentPluginProblem = Schema.Struct({
  directory: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
});
export type EnvironmentPluginProblem = typeof EnvironmentPluginProblem.Type;

export const EnvironmentPlugins = Schema.Struct({
  plugins: Schema.Array(EnvironmentPlugin),
  problems: Schema.Array(EnvironmentPluginProblem),
});
export type EnvironmentPlugins = typeof EnvironmentPlugins.Type;

export const EMPTY_ENVIRONMENT_PLUGINS: EnvironmentPlugins = { plugins: [], problems: [] };

/** Dots become underscores: `dev.example.glass` gives `plugin-dev_example_glass`. */
export function pluginCssPrefix(pluginId: PluginId): string {
  return `plugin-${pluginId.replaceAll(".", "_")}`;
}

/** `--` joins id and key; neither can contain it, so `plugin-dev_example_glass--blur` splits one way. */
export function pluginCssName(pluginId: PluginId, key: PluginSettingKey): string {
  return `${pluginCssPrefix(pluginId)}--${key}`;
}

export function resolvePluginSettingValue(
  setting: PluginSettingDefinition,
  stored: PluginSettingValue | undefined,
): PluginSettingValue {
  switch (setting.type) {
    case "boolean":
      return typeof stored === "boolean" ? stored : setting.default;
    case "select":
      return typeof stored === "string" && setting.options.some((option) => option.value === stored)
        ? stored
        : setting.default;
    case "range":
      return typeof stored === "number" && stored >= setting.min && stored <= setting.max
        ? stored
        : setting.default;
  }
}
