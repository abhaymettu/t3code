import {
  BackgroundImageAssetId,
  type ClientSettings,
  MAX_BACKGROUND_IMAGE_FADE,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";

const DATABASE_NAME = "t3code:background-images";
const STORE_NAME = "images";
const MAX_BACKGROUND_IMAGE_BYTES = 25 * 1024 * 1024;

const decodeAssetId = Schema.decodeSync(BackgroundImageAssetId);
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.addEventListener("upgradeneeded", () => {
      request.result.createObjectStore(STORE_NAME);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () =>
      reject(new Error("Background image store is blocked.")),
    );
  }).catch((error: unknown) => {
    database = undefined;
    throw error;
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

const MAX_BACKGROUND_IMAGE_EDGE = 3840;
// Decoding allocates 4 bytes a pixel, so a small file with huge dimensions could take gigabytes.
const MAX_BACKGROUND_IMAGE_PIXELS = 100_000_000;
const UNSUPPORTED_FORMAT = "This format isn’t supported. Try a JPEG, PNG or WebP.";

/** An import failure whose message is written for the person who picked the file. */
export class BackgroundImageImportError extends Error {}

/** Returns why a picked file cannot be a background image, or null when it can. */
export function backgroundImageImportError(file: {
  readonly type: string;
  readonly size: number;
}): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file.";
  if (file.size > MAX_BACKGROUND_IMAGE_BYTES) return "Choose an image under 25 MB.";
  return null;
}

/** Size an image is stored at: the long edge capped at 3840 px, aspect ratio kept. */
export function normalizedBackgroundImageSize(width: number, height: number) {
  const scale = Math.min(1, MAX_BACKGROUND_IMAGE_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function hasTransparency(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let index = 3; index < data.length; index += 4) {
    if (data[index]! < 255) return true;
  }
  return false;
}

function headerPixelCount(bytes: DataView): number | null {
  const ascii = (at: number, length: number) =>
    String.fromCharCode(...new Uint8Array(bytes.buffer, at, length));
  try {
    if (bytes.getUint32(0) === 0x89504e47) return bytes.getUint32(16) * bytes.getUint32(20);
    if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      const chunk = ascii(12, 4);
      if (chunk === "VP8 ") {
        return (bytes.getUint16(26, true) & 0x3fff) * (bytes.getUint16(28, true) & 0x3fff);
      }
      if (chunk === "VP8L") {
        const bits = bytes.getUint32(21, true);
        return ((bits & 0x3fff) + 1) * (((bits >>> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8X") {
        const width = (bytes.getUint32(24, true) & 0xffffff) + 1;
        return width * ((bytes.getUint32(26, true) >>> 8) + 1);
      }
      return null;
    }
    if (bytes.getUint16(0) !== 0xffd8) return null;
    for (let at = 2; bytes.getUint8(at) === 0xff; at += 2 + bytes.getUint16(at + 2)) {
      const marker = bytes.getUint8(at + 1);
      const isFrameHeader =
        marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isFrameHeader) return bytes.getUint16(at + 5) * bytes.getUint16(at + 7);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Decodes, downscales and re-encodes a picked image, so every window decodes at most a 4K image
 * and animated images keep only their first frame. WebP where the browser can encode it (Safari
 * cannot), otherwise JPEG, or PNG when the image has transparency.
 */
export async function normalizeBackgroundImage(file: Blob): Promise<Blob> {
  const pixels = headerPixelCount(new DataView(await file.arrayBuffer()));
  if (pixels === null) throw new BackgroundImageImportError(UNSUPPORTED_FORMAT);
  if (pixels > MAX_BACKGROUND_IMAGE_PIXELS) {
    throw new BackgroundImageImportError("Choose an image under 100 megapixels.");
  }
  return createImageBitmap(file).then(
    (bitmap) => {
      const { width, height } = normalizedBackgroundImageSize(bitmap.width, bitmap.height);
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) {
        bitmap.close();
        return Promise.reject(new BackgroundImageImportError(UNSUPPORTED_FORMAT));
      }
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      return canvas.convertToBlob({ type: "image/webp", quality: 0.9 }).then((webp) => {
        if (webp.type === "image/webp") return webp;
        return canvas.convertToBlob(
          hasTransparency(context, width, height)
            ? { type: "image/png" }
            : { type: "image/jpeg", quality: 0.92 },
        );
      });
    },
    () => Promise.reject(new BackgroundImageImportError(UNSUPPORTED_FORMAT)),
  );
}

export async function backgroundImageAssetId(bytes: ArrayBuffer): Promise<BackgroundImageAssetId> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return decodeAssetId(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

// Storage that is not persistent can be evicted under pressure, and IndexedDB holds the only copy.
function requestPersistentStorage() {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return;
  void storage
    .persisted()
    .then((persisted) => (persisted ? true : storage.persist()))
    .catch(() => undefined);
}

/** Normalizes a picked file and stores it; the id is the SHA-256 of the stored bytes. */
export async function importBackgroundImage(file: File): Promise<BackgroundImageAssetId> {
  const error = backgroundImageImportError(file);
  if (error) throw new BackgroundImageImportError(error);
  const image = await normalizeBackgroundImage(file);
  const assetId = await backgroundImageAssetId(await image.arrayBuffer());
  await withStore("readwrite", (store) => store.put(image, assetId));
  requestPersistentStorage();
  // Choosing the same file again after it went missing stores the same id, so read it afresh.
  if (loaded?.assetId === assetId && loaded.image.status === "missing") {
    forget();
    loadStoredBackgroundImage(assetId);
  }
  return assetId;
}

export async function deleteBackgroundImage(assetId: BackgroundImageAssetId): Promise<void> {
  if (loaded?.assetId === assetId) forget();
  await withStore("readwrite", (store) => store.delete(assetId));
}

export type StoredBackgroundImage =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "missing" };

const LOADING: StoredBackgroundImage = { status: "loading" };
const MISSING: StoredBackgroundImage = { status: "missing" };

// One image is active at a time, so the window background and the settings thumbnail share one
// object URL.
let loaded: { readonly assetId: BackgroundImageAssetId; image: StoredBackgroundImage } | null =
  null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeStoredBackgroundImage(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The newest decoded URL. The window keeps painting it while a newer image loads, so it is revoked
// only once something replaces it.
let shownUrl: string | null = null;

function show(url: string | null) {
  if (shownUrl !== null && shownUrl !== url) URL.revokeObjectURL(shownUrl);
  shownUrl = url;
}

function forget() {
  show(null);
  loaded = null;
  emit();
}

// Ready only once decoded, so the window never paints see-through panels over an image that has
// not arrived yet.
async function readImage(assetId: BackgroundImageAssetId): Promise<StoredBackgroundImage> {
  const blob = await withStore<Blob | undefined>("readonly", (store) => store.get(assetId));
  if (!(blob instanceof Blob)) return MISSING;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { status: "ready", url };
  } catch {
    URL.revokeObjectURL(url);
    return MISSING;
  }
}

/** Starts reading an image's bytes unless they are already loaded or loading. */
export function loadStoredBackgroundImage(assetId: BackgroundImageAssetId) {
  if (loaded?.assetId === assetId) return;
  const entry: { readonly assetId: BackgroundImageAssetId; image: StoredBackgroundImage } = {
    assetId,
    image: LOADING,
  };
  loaded = entry;
  void readImage(assetId)
    .catch(() => MISSING)
    .then((image) => {
      if (loaded !== entry) {
        if (image.status === "ready") URL.revokeObjectURL(image.url);
        return;
      }
      show(image.status === "ready" ? image.url : null);
      entry.image = image;
      emit();
    });
}

export function getStoredBackgroundImage(
  assetId: BackgroundImageAssetId | null,
): StoredBackgroundImage {
  if (assetId === null) return MISSING;
  return loaded?.assetId === assetId ? loaded.image : LOADING;
}

/** The stored bytes for an image id: loading, ready with an object URL, or missing on this device. */
export function useStoredBackgroundImage(
  assetId: BackgroundImageAssetId | null,
): StoredBackgroundImage {
  const image = useSyncExternalStore(subscribeStoredBackgroundImage, () =>
    getStoredBackgroundImage(assetId),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Starts the IndexedDB read for the asset the setting names. The module store holds its object URL until a different asset replaces it.
  useEffect(() => {
    if (assetId !== null) loadStoredBackgroundImage(assetId);
  }, [assetId]);
  return image;
}

export function shownBackgroundImageAssetId(
  settings: Pick<
    ClientSettings,
    "backgroundImageEnabled" | "backgroundImageAssetId" | "backgroundImageFade"
  >,
): BackgroundImageAssetId | null {
  return settings.backgroundImageEnabled && settings.backgroundImageFade < MAX_BACKGROUND_IMAGE_FADE
    ? settings.backgroundImageAssetId
    : null;
}

export function showBackgroundImage(root: HTMLElement, assetId: BackgroundImageAssetId | null) {
  if (assetId !== null) loadStoredBackgroundImage(assetId);
  const image = getStoredBackgroundImage(assetId);
  if (image.status === "loading") return;
  if (image.status === "ready") {
    root.style.setProperty("--background-image", `url("${image.url}")`);
  } else {
    root.style.removeProperty("--background-image");
  }
  root.toggleAttribute("data-background-image", image.status === "ready");
}
