import { describe, expect, it } from "vite-plus/test";

import {
  backgroundImageAssetId,
  backgroundImageImportError,
  normalizedBackgroundImageSize,
} from "./backgroundImageStore";

describe("backgroundImageImportError", () => {
  it("accepts images up to 25 MB", () => {
    expect(backgroundImageImportError({ type: "image/jpeg", size: 25 * 1024 * 1024 })).toBeNull();
  });

  it("rejects other file types and larger images", () => {
    expect(backgroundImageImportError({ type: "application/pdf", size: 10 })).toBe(
      "Choose an image file.",
    );
    expect(backgroundImageImportError({ type: "image/png", size: 25 * 1024 * 1024 + 1 })).toBe(
      "Choose an image under 25 MB.",
    );
  });
});

describe("backgroundImageAssetId", () => {
  it("is the lowercase SHA-256 of the bytes", async () => {
    const bytes = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    expect(await backgroundImageAssetId(bytes)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("normalizedBackgroundImageSize", () => {
  it("caps the long edge at 3840 px and keeps the aspect ratio", () => {
    expect(normalizedBackgroundImageSize(8000, 6000)).toEqual({ width: 3840, height: 2880 });
    expect(normalizedBackgroundImageSize(1648, 7000)).toEqual({ width: 904, height: 3840 });
  });

  it("never upscales", () => {
    expect(normalizedBackgroundImageSize(2944, 1648)).toEqual({ width: 2944, height: 1648 });
  });
});
