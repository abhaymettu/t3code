// @effect-diagnostics nodeBuiltinImport:off - stylesheet inlining resolves files synchronously
// through realpath and the guarded open, which the FileSystem service cannot do.
import * as NodeFS from "node:fs";

import {
  EMPTY_ENVIRONMENT_PLUGINS,
  type EnvironmentPlugin,
  type EnvironmentPluginProblem,
  type EnvironmentPlugins,
  PLUGIN_MANIFEST_FILE_NAME,
  PLUGIN_MANIFEST_PARSE_OPTIONS,
  PluginManifest,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "./config.ts";
import { readFileGuarded } from "./environmentTheme.ts";
import { inlinePluginStylesheet } from "./pluginStylesheet.ts";
import * as ServerSettingsService from "./serverSettings.ts";

const decodePluginManifestJson = Schema.decodeUnknownResult(Schema.fromJsonString(PluginManifest));

const MAX_PLUGIN_FOLDERS = 32;
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_STYLESHEET_BYTES = 256 * 1024;
const MAX_EMBEDDED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_EMBEDDED_BYTES_PER_PLUGIN = 8 * 1024 * 1024;
const MAX_EMBEDDED_BYTES_TOTAL = 16 * 1024 * 1024;
const MAX_PROBLEM_MESSAGE_LENGTH = 2_000;

interface PublishedPlugins {
  readonly seq: number;
  readonly plugins: EnvironmentPlugins;
}

export class EnvironmentPluginService extends Context.Service<
  EnvironmentPluginService,
  {
    readonly current: Effect.Effect<EnvironmentPlugins>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<EnvironmentPlugins>;
  }
>()("t3/environmentPlugins/EnvironmentPluginService") {}

const enabledPluginIds = (settings: ServerSettings): ReadonlyArray<string> =>
  Object.entries(settings.plugins)
    .filter(([, state]) => state.enabled)
    .map(([id]) => id)
    .toSorted();

const problem = (directory: string, message: string): EnvironmentPluginProblem => ({
  directory,
  message: message.slice(0, MAX_PROBLEM_MESSAGE_LENGTH),
});

/** Reads only files whose real path stays inside the plugin's real folder. */
const readPluginStylesheets = (
  pluginDir: string,
  styles: ReadonlyArray<string>,
  path: Path.Path,
): Result.Result<{ readonly stylesheet: string; readonly embeddedBytes: number }, string> => {
  const readInside = (relativePath: string, maxBytes: number) => {
    const filePath = path.join(pluginDir, relativePath);
    try {
      if (!NodeFS.realpathSync(filePath).startsWith(pluginDir + path.sep)) return null;
    } catch {
      return null;
    }
    return readFileGuarded(filePath, maxBytes);
  };

  let embeddedBytes = 0;
  const readEmbeddedFile = (relativePath: string): Result.Result<Uint8Array, string> => {
    const bytes = readInside(relativePath, MAX_EMBEDDED_FILE_BYTES);
    if (bytes === null) {
      return Result.fail(
        `${relativePath} is missing, larger than 4 MiB, a symlink, or outside the plugin folder.`,
      );
    }
    embeddedBytes += bytes.length;
    if (embeddedBytes > MAX_EMBEDDED_BYTES_PER_PLUGIN) {
      return Result.fail("The files its stylesheets embed add up to more than 8 MiB.");
    }
    return Result.succeed(bytes);
  };

  const stylesheets: Array<string> = [];
  for (const style of styles) {
    const css = readInside(style, MAX_STYLESHEET_BYTES);
    if (css === null) {
      return Result.fail(
        `${style} is missing, larger than 256 KiB, a symlink, or outside the plugin folder.`,
      );
    }
    const inlined = inlinePluginStylesheet(css.toString("utf8"), style, readEmbeddedFile);
    if (Result.isFailure(inlined)) return Result.fail(`${style}: ${inlined.failure}`);
    stylesheets.push(inlined.success);
  }
  return Result.succeed({ stylesheet: stylesheets.join("\n"), embeddedBytes });
};

const readEnvironmentPlugins = Effect.fn("EnvironmentPluginService.read")(function* (
  pluginsDir: string,
  enabledIds: ReadonlySet<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(pluginsDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const plugins: Array<EnvironmentPlugin> = [];
  const problems: Array<EnvironmentPluginProblem> = [];
  const directoriesById = new Map<string, string>();
  let examined = 0;
  let embeddedBytes = 0;
  for (const directory of entries.toSorted()) {
    if (directory.startsWith(".")) continue;
    const pluginDir = yield* fs.realPath(path.join(pluginsDir, directory)).pipe(Effect.option);
    if (pluginDir._tag === "None") continue;
    const info = yield* fs.stat(pluginDir.value).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "Directory") continue;

    examined += 1;
    if (examined > MAX_PLUGIN_FOLDERS) {
      problems.push(
        problem(directory, `Only the first ${MAX_PLUGIN_FOLDERS} plugin folders are read.`),
      );
      break;
    }

    const raw = readFileGuarded(
      path.join(pluginDir.value, PLUGIN_MANIFEST_FILE_NAME),
      MAX_MANIFEST_BYTES,
    );
    if (raw === null) {
      problems.push(
        problem(
          directory,
          `${PLUGIN_MANIFEST_FILE_NAME} is missing, larger than 32 KiB, or a symlink.`,
        ),
      );
      continue;
    }
    const decoded = decodePluginManifestJson(raw.toString("utf8"), PLUGIN_MANIFEST_PARSE_OPTIONS);
    if (Result.isFailure(decoded)) {
      problems.push(
        problem(directory, `${PLUGIN_MANIFEST_FILE_NAME} is not valid: ${decoded.failure.message}`),
      );
      continue;
    }
    const manifest = decoded.success;
    const owner = directoriesById.get(manifest.id);
    if (owner !== undefined) {
      problems.push(
        problem(directory, `The folder ${owner} already provides the plugin ${manifest.id}.`),
      );
      continue;
    }
    directoriesById.set(manifest.id, directory);

    const plugin: EnvironmentPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      ...(manifest.description !== undefined ? { description: manifest.description } : {}),
      settings: manifest.contributes.settings ?? [],
    };
    if (!enabledIds.has(manifest.id)) {
      plugins.push(plugin);
      continue;
    }
    const stylesheet = readPluginStylesheets(
      pluginDir.value,
      manifest.contributes.styles ?? [],
      path,
    );
    if (Result.isFailure(stylesheet)) {
      problems.push(problem(directory, stylesheet.failure));
      plugins.push(plugin);
      continue;
    }
    if (embeddedBytes + stylesheet.success.embeddedBytes > MAX_EMBEDDED_BYTES_TOTAL) {
      problems.push(
        problem(directory, "The files that enabled plugins embed add up to more than 16 MiB."),
      );
      plugins.push(plugin);
      continue;
    }
    embeddedBytes += stylesheet.success.embeddedBytes;
    plugins.push({ ...plugin, stylesheet: stylesheet.success.stylesheet });
  }
  return { plugins, problems } satisfies EnvironmentPlugins;
});

const make = Effect.gen(function* () {
  const { pluginsDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  // Sequence numbers let subscribers drop queued events older than their initial snapshot.
  const changes = yield* PubSub.sliding<PublishedPlugins>(1);
  const published = yield* Ref.make<PublishedPlugins>({
    seq: 0,
    plugins: EMPTY_ENVIRONMENT_PLUGINS,
  });
  // Serialize read/compare/publish so slow older reads cannot publish with newer sequence numbers.
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const settingsChanges = yield* serverSettings.subscribeChanges;
  const enabledIds = yield* Ref.make(
    yield* serverSettings.getSettings.pipe(
      Effect.map(enabledPluginIds),
      Effect.tapCause((cause) =>
        Effect.logWarning("could not read enabled plugins; publishing none enabled", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
  );

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const plugins = yield* readEnvironmentPlugins(
        pluginsDir,
        new Set(yield* Ref.get(enabledIds)),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedPlugins], PublishedPlugins] => {
          if (Equal.equals(previous.plugins, plugins)) return [[false, previous], previous];
          const updated: PublishedPlugins = { seq: previous.seq + 1, plugins };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  // Recursive so saving a file inside a plugin folder reloads it. Each install refreshes once more,
  // since a save between the last read and the install fires no event.
  const watchPlugins = Effect.gen(function* () {
    yield* fs.makeDirectory(pluginsDir, { recursive: true });
    const installed = yield* Deferred.make<void>();
    const events = fs
      .watch(pluginsDir, {
        recursive: true,
        onReady: () => Deferred.doneUnsafe(installed, Exit.void),
      })
      .pipe(Stream.debounce(Duration.millis(100)));
    yield* Stream.runForEach(
      Stream.merge(Stream.fromEffect(Deferred.await(installed)), events, { haltStrategy: "right" }),
      () => refresh.pipe(Effect.ignoreCause({ log: true })),
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  yield* refresh;
  // The watch ends or fails when the folder is deleted or replaced; start over on a fresh one.
  yield* watchPlugins.pipe(
    Effect.repeat(Schedule.spaced(Duration.seconds(1))),
    Effect.forkIn(watcherScope),
  );
  // Slider moves change settings too; only a different enabled set needs the folder read again.
  yield* Stream.runForEach(Stream.map(settingsChanges, enabledPluginIds), (next) =>
    Ref.getAndSet(enabledIds, next).pipe(
      Effect.flatMap((previous) => (Equal.equals(previous, next) ? Effect.void : refresh)),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkIn(watcherScope));

  return {
    current: Effect.map(Ref.get(published), (state) => state.plugins),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(published);
          return Stream.concat(
            Stream.make(snapshot.plugins),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.plugins),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentPluginService["Service"];
});

export const layer = Layer.effect(EnvironmentPluginService, make);
