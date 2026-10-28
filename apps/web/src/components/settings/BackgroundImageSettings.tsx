import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_BACKGROUND_IMAGE_FADE,
  MIN_BACKGROUND_IMAGE_FADE,
} from "@t3tools/contracts/settings";
import type { CSSProperties } from "react";
import { useRef, useState } from "react";

import {
  BackgroundImageImportError,
  deleteBackgroundImage,
  importBackgroundImage,
  useStoredBackgroundImage,
} from "../../assets/backgroundImageStore";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function BackgroundImageSection() {
  const enabled = useScopedSettings((settings) => settings.backgroundImageEnabled);
  const assetId = useScopedSettings((settings) => settings.backgroundImageAssetId);
  const fade = useScopedSettings((settings) => settings.backgroundImageFade);
  const updateSettings = useUpdateScopedSettings();
  const stored = useStoredBackgroundImage(enabled ? assetId : null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const [isImporting, setIsImporting] = useState(false);
  const hasImage = assetId !== null && stored.status !== "missing";
  const fadeRatio =
    (fade - MIN_BACKGROUND_IMAGE_FADE) / (MAX_BACKGROUND_IMAGE_FADE - MIN_BACKGROUND_IMAGE_FADE);
  const fadeSliderStyle = {
    "--settings-slider-progress": `${fadeRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - fadeRatio}rem`,
  } as CSSProperties;

  const removeImage = () => {
    if (assetId === null) return;
    updateSettings({ backgroundImageAssetId: null });
    void deleteBackgroundImage(assetId).catch(() => undefined);
    chooseButtonRef.current?.focus();
  };

  const chooseImage = (file: File) => {
    setIsImporting(true);
    importBackgroundImage(file)
      .then((nextAssetId) => {
        updateSettings({ backgroundImageAssetId: nextAssetId });
        if (assetId !== null && assetId !== nextAssetId) {
          void deleteBackgroundImage(assetId).catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          error instanceof BackgroundImageImportError
            ? { type: "error", title: "Couldn’t use that image", description: error.message }
            : { type: "error", title: "Couldn’t save the image", description: "Try again." },
        );
      })
      .finally(() => setIsImporting(false));
  };

  return (
    <SettingsSection id="appearance-background" title="Background">
      <SettingsRow
        {...searchableSetting("setting-background-image")}
        description="Show an image behind the window."
        resetAction={
          enabled !== DEFAULT_UNIFIED_SETTINGS.backgroundImageEnabled ? (
            <SettingResetButton
              label="background image"
              onClick={() =>
                updateSettings({
                  backgroundImageEnabled: DEFAULT_UNIFIED_SETTINGS.backgroundImageEnabled,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) =>
              updateSettings({ backgroundImageEnabled: Boolean(checked) })
            }
            aria-label="Show background image"
          />
        }
      />
      {enabled ? (
        <>
          <SettingsRow
            title="Image"
            description={
              assetId !== null && stored.status === "missing"
                ? "This image isn’t on this device. Choose it again."
                : hasImage
                  ? "Stored on this device only."
                  : "Choose a JPEG, PNG, or WebP image. It stays on this device."
            }
            control={
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  accept="image/jpeg,image/png,image/webp"
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) chooseImage(file);
                  }}
                  tabIndex={-1}
                  type="file"
                />
                {hasImage ? (
                  stored.status === "ready" ? (
                    <img
                      alt="Background image preview"
                      className="h-8 w-14 rounded-md object-cover ring-1 ring-border"
                      src={stored.url}
                    />
                  ) : (
                    <div className="h-8 w-14 rounded-md bg-muted" />
                  )
                ) : null}
                <Button
                  ref={chooseButtonRef}
                  disabled={isImporting}
                  onClick={() => fileInputRef.current?.click()}
                  size="sm"
                  variant="outline"
                >
                  {isImporting ? "Saving…" : hasImage ? "Replace" : "Choose image"}
                </Button>
                {assetId !== null ? (
                  <Button onClick={removeImage} size="sm" variant="outline">
                    Remove
                  </Button>
                ) : null}
              </div>
            }
          />
          {hasImage ? (
            <SettingsRow
              title="Fade"
              description="How far the photo fades into the app’s background."
              resetAction={
                fade !== DEFAULT_UNIFIED_SETTINGS.backgroundImageFade ? (
                  <SettingResetButton
                    label="fade"
                    onClick={() =>
                      updateSettings({
                        backgroundImageFade: DEFAULT_UNIFIED_SETTINGS.backgroundImageFade,
                      })
                    }
                  />
                ) : null
              }
              control={
                <div className="flex w-full items-center gap-3 sm:w-52">
                  <output
                    className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                    htmlFor="background-image-fade"
                  >
                    {fade}%
                  </output>
                  <input
                    aria-label="Fade"
                    className="settings-slider min-w-0 flex-1"
                    id="background-image-fade"
                    max={MAX_BACKGROUND_IMAGE_FADE}
                    min={MIN_BACKGROUND_IMAGE_FADE}
                    onChange={(event) => {
                      const backgroundImageFade = Number(event.currentTarget.value);
                      if (
                        Number.isInteger(backgroundImageFade) &&
                        backgroundImageFade >= MIN_BACKGROUND_IMAGE_FADE &&
                        backgroundImageFade <= MAX_BACKGROUND_IMAGE_FADE
                      ) {
                        updateSettings({ backgroundImageFade });
                      }
                    }}
                    step={5}
                    style={fadeSliderStyle}
                    type="range"
                    value={fade}
                  />
                </div>
              }
            />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}
