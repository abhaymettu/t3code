import {
  type BackgroundImageAssetId,
  MIN_BACKGROUND_IMAGE_FADE,
} from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import {
  getStoredBackgroundImage,
  importBackgroundImage,
  loadStoredBackgroundImage,
  showBackgroundImage,
  shownBackgroundImageAssetId,
} from "./assets/backgroundImageStore";

const root = document.documentElement;

function showImage(fade: number, appearance: "light" | "dark", photo = "#336"): Disposable {
  root.classList.toggle("dark", appearance === "dark");
  root.style.setProperty("--background-image", `linear-gradient(${photo}, ${photo})`);
  root.style.setProperty("--background-image-fade", String(fade));
  root.toggleAttribute("data-background-image", true);
  return {
    [Symbol.dispose]: () => {
      root.classList.remove("dark");
      root.removeAttribute("data-background-image");
      root.style.removeProperty("--background-image");
      root.style.removeProperty("--background-image-fade");
    },
  };
}

function behindTheWindow() {
  return getComputedStyle(document.body, "::before");
}

function washStops(): string[] {
  const [wash = ""] = behindTheWindow().backgroundImage.split("url(");
  return [...wash.matchAll(/color\(srgb [^)]*\)/g)].map(([stop]) => stop);
}

function washStopAlphas(): number[] {
  return washStops().map((stop) => Number(/\/ ([\d.]+)\)/.exec(stop)?.[1] ?? 1));
}

const canvas = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
function rgba(color: string): number[] {
  canvas.clearRect(0, 0, 1, 1);
  canvas.fillStyle = color;
  canvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, a! / 255];
}

function luminance([r, g, b]: number[]): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!);
}

function contrastOverPhoto(textColor: string, photo: string): number {
  const veil = rgba(washStops().at(-1)!);
  const underneath = rgba(photo);
  const background = [0, 1, 2].map((i) => veil[i]! * veil[3]! + underneath[i]! * (1 - veil[3]!));
  const [light, dark] = [luminance(rgba(textColor)), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

function textColor(html: string): string {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  const color = getComputedStyle(host.querySelector("[data-probe]")!).color;
  host.remove();
  return color;
}

describe("background image wash", () => {
  it("paints nothing behind the window without an image", async () => {
    await vi.waitFor(() => expect(behindTheWindow().content).toBe("none"));

    using _image = showImage(0.7, "light");

    await vi.waitFor(() => expect(behindTheWindow().content).toBe('""'));
  });

  it("veils the photo evenly by the Fade amount, with more at the top in dark mode", async () => {
    {
      using _image = showImage(0.7, "light");
      await vi.waitFor(() => expect(washStopAlphas()).toEqual([0.7, 0.7]));
    }
    using _image = showImage(0.7, "dark");
    await vi.waitFor(() => expect(washStopAlphas()).toEqual([0.875, 0.7]));
  });

  it.each([
    ["light", "#000"],
    ["dark", "#fff"],
  ] as const)(
    "keeps secondary, link and status text at 4.5:1 at the least Fade, %s mode over a %s photo",
    async (appearance, photo) => {
      using _image = showImage(MIN_BACKGROUND_IMAGE_FADE / 100, appearance, photo);
      await vi.waitFor(() => expect(washStops()).toHaveLength(2));

      const overPhoto = (html: string) =>
        textColor(`<main data-slot="sidebar-inset">${html}</main>`);
      const texts = {
        muted: overPhoto('<span data-probe class="text-muted-foreground">a</span>'),
        sidebarMuted: textColor(
          '<div data-app-sidebar><span data-probe class="text-sidebar-muted-foreground">a</span></div>',
        ),
        link: overPhoto('<div class="chat-markdown"><a data-probe href="#a">a</a></div>'),
        success: overPhoto('<span data-probe class="text-success-foreground">a</span>'),
        warning: overPhoto('<span data-probe class="text-warning-foreground">a</span>'),
        error: overPhoto('<span data-probe class="text-error-foreground">a</span>'),
      };
      for (const [name, color] of Object.entries(texts)) {
        expect(contrastOverPhoto(color, photo), name).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("leaves the theme's colors on menus and dialogs, which stay solid", async () => {
    const menuText = () =>
      ["text-muted-foreground", "text-success-foreground"].map((name) =>
        textColor(`<div role="menu"><span data-probe class="${name}">a</span></div>`),
      );
    const stock = menuText();

    using _image = showImage(MIN_BACKGROUND_IMAGE_FADE / 100, "light", "#000");
    await vi.waitFor(() => expect(washStops()).toHaveLength(2));

    expect(menuText()).toEqual(stock);
    expect(
      textColor(
        '<main data-slot="sidebar-inset"><span data-probe class="text-muted-foreground">a</span></main>',
      ),
    ).not.toEqual(stock[0]);
  });
});

describe("showBackgroundImage", () => {
  async function storedImage(fill: string) {
    const canvas = new OffscreenCanvas(16, 9);
    const context = canvas.getContext("2d")!;
    context.fillStyle = fill;
    context.fillRect(0, 0, 16, 9);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const assetId = await importBackgroundImage(
      new File([blob], "photo.png", { type: "image/png" }),
    );
    loadStoredBackgroundImage(assetId);
    await vi.waitFor(() => expect(getStoredBackgroundImage(assetId).status).toBe("ready"));
    return { assetId, url: (getStoredBackgroundImage(assetId) as { url: string }).url };
  }
  const shown = () => [
    root.hasAttribute("data-background-image"),
    root.style.getPropertyValue("--background-image"),
  ];

  it("keeps the current image while the next one loads, and clears it when there is none", async () => {
    const stored = await storedImage("#204080");
    showBackgroundImage(root, stored.assetId);
    expect(shown()).toEqual([true, `url("${stored.url}")`]);

    const notOnThisDevice = "cd".padEnd(64, "0") as BackgroundImageAssetId;
    showBackgroundImage(root, notOnThisDevice);
    expect(shown()).toEqual([true, `url("${stored.url}")`]);
    await vi.waitFor(() => {
      showBackgroundImage(root, notOnThisDevice);
      expect(shown()).toEqual([false, ""]);
    });

    showBackgroundImage(root, stored.assetId);
    await vi.waitFor(() => {
      showBackgroundImage(root, stored.assetId);
      expect(shown()).toEqual([true, expect.stringMatching(/^url\("blob:/)]);
    });
    showBackgroundImage(root, null);
    expect(shown()).toEqual([false, ""]);
  });

  it("shows the image only while the setting is on and Fade is under 100", () => {
    const assetId = "ab".padEnd(64, "0") as BackgroundImageAssetId;
    const shownAt = (backgroundImageEnabled: boolean, backgroundImageFade: number) =>
      shownBackgroundImageAssetId({
        backgroundImageEnabled,
        backgroundImageAssetId: assetId,
        backgroundImageFade,
      });

    expect([shownAt(true, 70), shownAt(true, 95), shownAt(true, 100), shownAt(false, 70)]).toEqual([
      assetId,
      assetId,
      null,
      null,
    ]);
  });
});
