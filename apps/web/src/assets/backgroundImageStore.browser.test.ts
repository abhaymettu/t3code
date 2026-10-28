import { describe, expect, it, vi } from "vite-plus/test";

import {
  BackgroundImageImportError,
  deleteBackgroundImage,
  getStoredBackgroundImage,
  importBackgroundImage,
  loadStoredBackgroundImage,
  normalizeBackgroundImage,
} from "./backgroundImageStore";

function imageOf(width: number, height: number, fill: string, type = "image/png") {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d")!;
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  return canvas.convertToBlob({ type });
}

function header(type: string, write: (bytes: DataView) => void) {
  const bytes = new DataView(new ArrayBuffer(48));
  write(bytes);
  return new Blob([bytes.buffer], { type });
}
const ascii = (bytes: DataView, at: number, text: string) =>
  [...text].forEach((char, index) => bytes.setUint8(at + index, char.charCodeAt(0)));
const webp = (chunk: string, write: (bytes: DataView) => void) =>
  header("image/webp", (bytes) => {
    ascii(bytes, 0, "RIFF");
    ascii(bytes, 8, "WEBP");
    ascii(bytes, 12, chunk);
    write(bytes);
  });

describe("normalizeBackgroundImage", () => {
  it("downscales a large photo to a 3840 px long edge and stores it as WebP", async () => {
    const stored = await normalizeBackgroundImage(await imageOf(6000, 4000, "#3060c0"));
    const bitmap = await createImageBitmap(stored);
    expect([stored.type, bitmap.width, bitmap.height]).toEqual(["image/webp", 3840, 2560]);
  });

  it("keeps transparency", async () => {
    const stored = await normalizeBackgroundImage(await imageOf(40, 20, "rgb(255 0 0 / 0.5)"));
    const bitmap = await createImageBitmap(stored);
    const context = new OffscreenCanvas(40, 20).getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const alpha = context.getImageData(20, 10, 1, 1).data[3]!;
    expect(Math.abs(alpha - 128)).toBeLessThan(8);
  });

  it.each([
    ["JPEG", "image/jpeg", "#3060c0"],
    ["lossy WebP", "image/webp", "#3060c0"],
    ["WebP with transparency", "image/webp", "rgb(48 96 192 / 0.5)"],
  ])("reads a %s", async (_name, type, fill) => {
    const stored = await normalizeBackgroundImage(await imageOf(300, 200, fill, type));
    const bitmap = await createImageBitmap(stored);
    expect([bitmap.width, bitmap.height]).toEqual([300, 200]);
  });

  it.each([
    [
      "PNG",
      header("image/png", (bytes) =>
        [0x89504e47, 0x0d0a1a0a, 13, 0x49484452, 12_000, 9_000].forEach((word, index) =>
          bytes.setUint32(index * 4, word),
        ),
      ),
    ],
    [
      "JPEG",
      header("image/jpeg", (bytes) => {
        [0xffd8, 0xffe0, 4, 0, 0xffc0, 17].forEach((word, index) =>
          bytes.setUint16(index * 2, word),
        );
        bytes.setUint8(12, 8);
        bytes.setUint16(13, 9_000);
        bytes.setUint16(15, 12_000);
      }),
    ],
    [
      "lossy WebP",
      webp("VP8 ", (bytes) => {
        bytes.setUint16(26, 12_000, true);
        bytes.setUint16(28, 9_000, true);
      }),
    ],
    [
      "lossless WebP",
      webp("VP8L", (bytes) => bytes.setUint32(21, (12_000 - 1) | ((9_000 - 1) << 14), true)),
    ],
    [
      "extended WebP",
      webp("VP8X", (bytes) => {
        bytes.setUint16(24, 12_000 - 1, true);
        bytes.setUint16(27, 9_000 - 1, true);
      }),
    ],
  ])("rejects a %s over 100 megapixels before decoding it", async (_name, image) => {
    await expect(normalizeBackgroundImage(image)).rejects.toEqual(
      new BackgroundImageImportError("Choose an image under 100 megapixels."),
    );
  });

  it("rejects bytes the browser cannot decode with a message for the user", async () => {
    const heic = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99])], {
      type: "image/heic",
    });
    await expect(normalizeBackgroundImage(heic)).rejects.toEqual(
      new BackgroundImageImportError("This format isn’t supported. Try a JPEG, PNG or WebP."),
    );
  });
});

describe("stored background images", () => {
  it("opens the store again after a failed open", async () => {
    const file = new File([await imageOf(30, 20, "#a04020")], "ember.png", { type: "image/png" });
    const open = vi.spyOn(indexedDB, "open").mockImplementationOnce(() => {
      throw new DOMException("The store could not open.", "UnknownError");
    });

    await expect(importBackgroundImage(file)).rejects.toThrow("The store could not open.");
    open.mockRestore();

    const assetId = await importBackgroundImage(file);
    loadStoredBackgroundImage(assetId);
    await vi.waitFor(() => expect(getStoredBackgroundImage(assetId).status).toBe("ready"));
  });

  async function storedStatus(assetId: Parameters<typeof loadStoredBackgroundImage>[0]) {
    loadStoredBackgroundImage(assetId);
    await vi.waitFor(() => expect(getStoredBackgroundImage(assetId).status).not.toBe("loading"));
    return getStoredBackgroundImage(assetId).status;
  }

  it("reads back an imported image, forgets it once deleted, and finds it again when re-chosen", async () => {
    const file = new File([await imageOf(30, 20, "#208040")], "leaf.png", { type: "image/png" });

    const assetId = await importBackgroundImage(file);
    expect(await storedStatus(assetId)).toBe("ready");

    await deleteBackgroundImage(assetId);
    expect(await storedStatus(assetId)).toBe("missing");

    expect(await importBackgroundImage(file)).toBe(assetId);
    await vi.waitFor(() => expect(getStoredBackgroundImage(assetId).status).toBe("ready"));
  });
});
