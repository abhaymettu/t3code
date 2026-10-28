import { useAtomValue } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  pluginCssName,
  resolvePluginSettingValue,
  type EnvironmentPlugin,
  type EnvironmentPluginProblem,
  type PluginId,
  type PluginRangeSetting,
  type PluginSettingDefinition,
  type PluginSettingValue,
  type PluginState,
  type PluginStatePatch,
} from "@t3tools/contracts";
import { PuzzleIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { previewPluginRangeSetting } from "../../plugins/pluginStyles";
import { primaryServerConfigAtom, primaryServerEnvironmentPluginsAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { pluginSettingsSearchId, searchableSetting } from "./settingsSearch";

const PLUGINS_GUIDE_URL = "https://github.com/pingdotgg/t3code/blob/main/docs/user/plugins.md";
const DISABLED_PLUGIN: PluginState = { enabled: false, values: {} };

/** Plugins belong to the environment serving this app, which is also the one whose styles apply. */
export function PluginsSettingsPanel() {
  const config = useAtomValue(primaryServerConfigAtom);
  const { plugins, problems } = useAtomValue(primaryServerEnvironmentPluginsAtom);
  const states = usePrimarySettings((settings) => settings.plugins);
  const updateSettings = useUpdatePrimarySettings();
  const canWrite = useEnvironmentScope(usePrimaryEnvironmentId(), AuthSettingsWriteScope);
  const environmentLabel = usePrimaryEnvironment()?.label ?? "the server";

  if (config !== null && config.environment.capabilities.environmentPlugins !== true) {
    return (
      <SettingsPageContainer>
        <p id={searchableSetting("plugins").id} className="text-sm text-muted-foreground">
          Update {environmentLabel} to use plugins.
        </p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      {plugins.length === 0 && problems.length === 0 ? (
        <SettingsSection {...searchableSetting("plugins")} hideTitle>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PuzzleIcon />
              </EmptyMedia>
              <EmptyTitle>No plugins installed</EmptyTitle>
              <EmptyDescription>
                A plugin is a folder with a t3-plugin.json. Add one to this environment's plugins
                folder and it shows up here.{" "}
                <a
                  href={PLUGINS_GUIDE_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Read the guide
                </a>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </SettingsSection>
      ) : null}
      {!canWrite && plugins.length > 0 ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          This connection lacks permission to change plugins on {environmentLabel}.
        </p>
      ) : null}
      {plugins.map((plugin) => (
        <PluginSection
          key={plugin.id}
          plugin={plugin}
          state={states[plugin.id] ?? DISABLED_PLUGIN}
          disabled={!canWrite}
          onChange={(patch) => updateSettings({ plugins: { [plugin.id]: patch } })}
        />
      ))}
      {problems.length > 0 ? <PluginProblems problems={problems} /> : null}
    </SettingsPageContainer>
  );
}

function PluginSection({
  plugin,
  state,
  disabled,
  onChange,
}: {
  plugin: EnvironmentPlugin;
  state: PluginState;
  disabled: boolean;
  onChange: (patch: PluginStatePatch) => void;
}) {
  const setValue = (key: string, value: PluginSettingValue | null) =>
    onChange({ values: { [key]: value } });

  return (
    <SettingsSection
      id={pluginSettingsSearchId(plugin.id)}
      title={plugin.name}
      headerAction={
        <Switch
          checked={state.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => onChange({ enabled: Boolean(checked) })}
          aria-label={`Enable ${plugin.name}`}
        />
      }
    >
      <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
        Version {plugin.version}
        {plugin.description ? ` · ${plugin.description}` : null}
      </p>
      {state.enabled
        ? plugin.settings.map((setting) => {
            const value = resolvePluginSettingValue(setting, state.values[setting.key]);
            return (
              <SettingsRow
                key={setting.key}
                title={setting.title}
                description={setting.description}
                resetAction={
                  value !== setting.default && !disabled ? (
                    <SettingResetButton
                      label={setting.title.toLowerCase()}
                      onClick={() => setValue(setting.key, null)}
                    />
                  ) : null
                }
                control={
                  <PluginSettingControl
                    pluginId={plugin.id}
                    setting={setting}
                    value={value}
                    disabled={disabled}
                    onChange={(next) => setValue(setting.key, next)}
                  />
                }
              />
            );
          })
        : null}
    </SettingsSection>
  );
}

function PluginSettingControl({
  pluginId,
  setting,
  value,
  disabled,
  onChange,
}: {
  pluginId: PluginId;
  setting: PluginSettingDefinition;
  value: PluginSettingValue;
  disabled: boolean;
  onChange: (value: PluginSettingValue) => void;
}) {
  switch (setting.type) {
    case "boolean":
      return (
        <Switch
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(Boolean(checked))}
          aria-label={setting.title}
        />
      );
    case "select":
      return (
        <Select
          value={String(value)}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string") onChange(next);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={setting.title}>
            <SelectValue>
              {setting.options.find((option) => option.value === value)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {setting.options.map((option) => (
              <SelectItem key={option.value} hideIndicator value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      );
    case "range":
      return (
        <PluginRangeControl
          pluginId={pluginId}
          setting={setting}
          value={Number(value)}
          disabled={disabled}
          onChange={onChange}
        />
      );
  }
}

const SLIDER_COMMIT_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

function PluginRangeControl({
  pluginId,
  setting,
  value,
  disabled,
  onChange,
}: {
  pluginId: PluginId;
  setting: PluginRangeSetting;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  // The thumb and the page follow the drag; the value is saved once, on release.
  const [draft, setDraft] = useState<number | null>(null);
  if (draft !== null && draft === value) setDraft(null);
  const shown = draft ?? value;
  const ratio = (shown - setting.min) / (setting.max - setting.min);
  const style = {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
  const id = pluginCssName(pluginId, setting.key);
  const commit = () => {
    if (draft !== null && draft !== value) onChange(draft);
  };

  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={id}
      >
        {shown}
        {setting.unit}
      </output>
      <input
        aria-label={setting.title}
        className="settings-slider min-w-0 flex-1"
        disabled={disabled}
        id={id}
        max={setting.max}
        min={setting.min}
        onBlur={commit}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          if (Number.isFinite(next) && next >= setting.min && next <= setting.max) {
            setDraft(next);
            previewPluginRangeSetting(pluginId, setting, next);
          }
        }}
        onKeyUp={(event) => {
          if (SLIDER_COMMIT_KEYS.has(event.key)) commit();
        }}
        onPointerUp={commit}
        step={setting.step}
        style={style}
        type="range"
        value={shown}
      />
    </div>
  );
}

function PluginProblems({ problems }: { problems: ReadonlyArray<EnvironmentPluginProblem> }) {
  return (
    <SettingsSection title="Problems">
      {problems.map((problem) => (
        <SettingsRow
          key={problem.directory}
          title={
            <span className="flex items-center gap-1.5">
              <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
              <span className="font-mono">{problem.directory}</span>
            </span>
          }
          description={problem.message}
        />
      ))}
    </SettingsSection>
  );
}
