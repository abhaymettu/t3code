import {
  type BackgroundImageAssetId,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import {
  getStoredBackgroundImage,
  loadStoredBackgroundImage,
} from "../../assets/backgroundImageStore";
import { AppearanceSettingsPanel } from "./AppearanceSettingsPanel";
import { BackgroundImageSection } from "./BackgroundImageSettings";

const settings = vi.hoisted(() => ({
  value: null as unknown as UnifiedSettings,
  listeners: new Set<() => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (<T,>(select: (current: UnifiedSettings) => T = (current) => current as T) =>
    select(
      useSyncExternalStore(
        (listener) => {
          settings.listeners.add(listener);
          return () => settings.listeners.delete(listener);
        },
        () => settings.value,
      ),
    )) as never,
  useUpdateScopedSettings: (() => (patch: Partial<UnifiedSettings>) => {
    settings.value = { ...settings.value, ...patch };
    for (const listener of settings.listeners) listener();
  }) as never,
}));

function setup(patch: Partial<UnifiedSettings> = {}) {
  settings.value = { ...DEFAULT_UNIFIED_SETTINGS, ...patch };
}

async function pngFile(name: string) {
  const canvas = new OffscreenCanvas(64, 32);
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#2050a0";
  context.fillRect(0, 0, 64, 32);
  return new File([await canvas.convertToBlob({ type: "image/png" })], name, {
    type: "image/png",
  });
}

function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("BackgroundImageSection", () => {
  it("is off by default and shows the image row once turned on", async () => {
    setup();
    await using screen = await render(<BackgroundImageSection />);

    const toggle = screen.getByRole("switch", { name: "Show background image" });
    await expect.element(toggle).not.toBeChecked();
    expect(document.querySelector("#background-image-fade")).toBeNull();

    await toggle.click();

    await expect.element(screen.getByRole("button", { name: "Choose image" })).toBeVisible();
    expect(settings.value.backgroundImageEnabled).toBe(true);
  });

  it("stores a chosen image, previews it, and Remove deletes its bytes", async () => {
    setup({ backgroundImageEnabled: true });
    await using screen = await render(<BackgroundImageSection />);

    choose(await pngFile("sky.png"));

    await expect.element(screen.getByRole("button", { name: "Replace" })).toBeVisible();
    await expect
      .element(screen.getByRole("img", { name: "Background image preview" }))
      .toBeVisible();
    const assetId = settings.value.backgroundImageAssetId as BackgroundImageAssetId;
    expect(assetId).toMatch(/^[0-9a-f]{64}$/);

    await screen.getByRole("button", { name: "Remove" }).click();

    await expect.element(screen.getByRole("button", { name: "Choose image" })).toBeVisible();
    expect(settings.value.backgroundImageAssetId).toBeNull();
    await vi.waitFor(() => {
      loadStoredBackgroundImage(assetId);
      expect(getStoredBackgroundImage(assetId).status).toBe("missing");
    });
  });

  it("says when the chosen image is not on this device", async () => {
    setup({
      backgroundImageEnabled: true,
      backgroundImageAssetId: "e3".padEnd(64, "0") as BackgroundImageAssetId,
    });
    await using screen = await render(<BackgroundImageSection />);

    await expect
      .element(screen.getByText("This image isn’t on this device. Choose it again."))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Choose image" })).toBeVisible();
  });

  it("changes fade and resets it to the default", async () => {
    setup({ backgroundImageEnabled: true });
    await using screen = await render(<BackgroundImageSection />);
    choose(await pngFile("dusk.png"));

    const slider = screen.getByRole("slider", { name: "Fade" });
    await slider.fill("80");
    await expect.element(screen.getByText("80%")).toBeVisible();
    expect(settings.value.backgroundImageFade).toBe(80);

    await screen.getByRole("button", { name: "Reset fade to default" }).click();

    await expect.element(slider).toHaveValue("70");
    expect(settings.value.backgroundImageFade).toBe(70);
  });

  it("disables Glass opacity while an image shows, since the image keeps glass solid", async () => {
    setup({ backgroundImageEnabled: true });
    await using screen = await render(<AppearanceSettingsPanel />);
    const glass = screen.getByRole("slider", { name: "Glass opacity" });
    await expect.element(glass).toBeEnabled();

    choose(await pngFile("noon.png"));

    await expect.element(glass).toBeDisabled();
    await expect.element(screen.getByText("Solid while a background image shows.")).toBeVisible();
    await screen.getByRole("slider", { name: "Fade" }).fill("100");
    await expect.element(glass).toBeEnabled();
  });
});
