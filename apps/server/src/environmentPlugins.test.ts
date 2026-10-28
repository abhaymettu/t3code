import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentPlugins as PublishedPlugins,
  type PluginManifest,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "./config.ts";
import * as EnvironmentPlugins from "./environmentPlugins.ts";
import * as ServerSettingsService from "./serverSettings.ts";

const BACKDROP: PluginManifest = {
  manifestVersion: 1,
  id: "dev.example.backdrop",
  version: "1.0.0",
  apiVersion: 1,
  name: "Backdrop",
  contributes: {
    styles: ["./backdrop.css"],
    settings: [{ type: "boolean", key: "sidebar", title: "Behind the sidebar", default: false }],
  },
};

const LEAKY: PluginManifest = {
  manifestVersion: 1,
  id: "dev.example.leaky",
  version: "0.1.0",
  apiVersion: 1,
  name: "Leaky",
  contributes: { styles: ["./leaky.css"] },
};

const BACKDROP_FILES = {
  "backdrop/t3-plugin.json": JSON.stringify(BACKDROP),
  "backdrop/backdrop.css": "body { background: url(images/bg.png); }",
  "backdrop/images/bg.png": "png",
};
const LEAKY_FILES = {
  "leaky/t3-plugin.json": JSON.stringify(LEAKY),
  "leaky/leaky.css": "body { background: url(https://example.com/bg.png); }",
};

const BACKDROP_LISTING = {
  id: "dev.example.backdrop",
  name: "Backdrop",
  version: "1.0.0",
  settings: BACKDROP.contributes.settings ?? [],
};
const BACKDROP_STYLESHEET = 'body { background: url("data:image/png;base64,cG5n"); }';

/** The real settings service needs a secret store and a watched file; this one only announces changes. */
const layerSettings = (initial: ServerSettings["plugins"]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* Ref.make<ServerSettings>({
        ...DEFAULT_SERVER_SETTINGS,
        plugins: initial,
      });
      const changes = yield* PubSub.unbounded<ServerSettings>();
      return Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Ref.get(settings),
        updateSettings: (patch: ServerSettingsPatch) =>
          Ref.updateAndGet(settings, (current) => applyServerSettingsPatch(current, patch)).pipe(
            Effect.tap((next) => PubSub.publish(changes, next)),
          ),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  );

interface TestEnvironmentOptions {
  /** Runs on the seeded folder before the service reads it. */
  readonly prepare?: (
    pluginsDir: string,
  ) => Effect.Effect<void, PlatformError, FileSystem.FileSystem | Path.Path>;
  /** Replaces the folder watch the service starts. */
  readonly watch?: FileSystem.FileSystem["watch"];
}

const withEnvironmentPlugins = <A, E>(
  seeds: Readonly<Record<string, string>>,
  enabled: ReadonlyArray<string>,
  body: Effect.Effect<
    A,
    E,
    | EnvironmentPlugins.EnvironmentPluginService
    | ServerSettingsService.ServerSettingsService
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
  options: TestEnvironmentOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-environment-plugins-" });
    const pluginsDir = path.join(baseDir, "userdata", "plugins");
    for (const [relativePath, contents] of Object.entries(seeds)) {
      yield* fs.makeDirectory(path.dirname(path.join(pluginsDir, relativePath)), {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(pluginsDir, relativePath), contents);
    }
    if (options.prepare !== undefined) yield* options.prepare(pluginsDir);
    const watch = options.watch;

    return yield* body.pipe(
      Effect.provide(
        EnvironmentPlugins.layer.pipe(
          Layer.provide(
            watch === undefined
              ? Layer.empty
              : Layer.succeed(FileSystem.FileSystem, { ...fs, watch }),
          ),
          Layer.provideMerge(
            layerSettings(
              Object.fromEntries(enabled.map((id) => [id, { enabled: true, values: {} }])),
            ),
          ),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        ),
      ),
    );
  }).pipe(Effect.scoped);

const currentPlugins = Effect.gen(function* () {
  const environmentPlugins = yield* EnvironmentPlugins.EnvironmentPluginService;
  return yield* environmentPlugins.current;
});

const collectChanges = Effect.gen(function* () {
  const environmentPlugins = yield* EnvironmentPlugins.EnvironmentPluginService;
  const seen = yield* Queue.unbounded<PublishedPlugins>();
  yield* Stream.runForEach(environmentPlugins.streamChanges, (plugins) =>
    Queue.offer(seen, plugins),
  ).pipe(Effect.forkScoped);
  return seen;
});

it.layer(NodeServices.layer)("environment plugins", (it) => {
  it.effect("lists valid plugins and reports each broken folder in plain words", () =>
    withEnvironmentPlugins(
      {
        ...BACKDROP_FILES,
        ...LEAKY_FILES,
        "copy/t3-plugin.json": JSON.stringify(BACKDROP),
        "empty/notes.txt": "no manifest",
        "greedy/t3-plugin.json": JSON.stringify({ ...LEAKY, entrypoints: { main: "./x.js" } }),
        "malformed/t3-plugin.json": "{ not json",
        "README.md": "not a plugin folder",
      },
      [],
      Effect.gen(function* () {
        assert.deepEqual(yield* currentPlugins, {
          plugins: [
            BACKDROP_LISTING,
            { id: "dev.example.leaky", name: "Leaky", version: "0.1.0", settings: [] },
          ],
          problems: [
            {
              directory: "copy",
              message: "The folder backdrop already provides the plugin dev.example.backdrop.",
            },
            {
              directory: "empty",
              message: "t3-plugin.json is missing, larger than 32 KiB, or a symlink.",
            },
            {
              directory: "greedy",
              message:
                't3-plugin.json is not valid: Expected no excess property\n  at ["entrypoints"]',
            },
            {
              directory: "malformed",
              message: "t3-plugin.json is not valid: Expected a valid JSON string",
            },
          ],
        });
      }),
    ),
  );

  it.effect(
    "inlines the stylesheet of an enabled plugin and withholds one that loads from outside",
    () =>
      withEnvironmentPlugins(
        { ...BACKDROP_FILES, ...LEAKY_FILES },
        ["dev.example.backdrop", "dev.example.leaky"],
        Effect.gen(function* () {
          assert.deepEqual(yield* currentPlugins, {
            plugins: [
              { ...BACKDROP_LISTING, stylesheet: BACKDROP_STYLESHEET },
              { id: "dev.example.leaky", name: "Leaky", version: "0.1.0", settings: [] },
            ],
            problems: [
              {
                directory: "leaky",
                message:
                  "./leaky.css: url(https://example.com/bg.png) must be a data: URL or a file in the plugin folder.",
              },
            ],
          });
        }),
      ),
  );

  it.effect.skipIf(!symlinksSupported)(
    "refuses a file reached through a symlinked folder that leaves the plugin",
    () =>
      withEnvironmentPlugins(
        {
          "backdrop/t3-plugin.json": JSON.stringify(BACKDROP),
          "backdrop/backdrop.css": BACKDROP_FILES["backdrop/backdrop.css"],
          "../outside/bg.png": "png",
        },
        ["dev.example.backdrop"],
        Effect.gen(function* () {
          assert.deepEqual((yield* currentPlugins).problems, [
            {
              directory: "backdrop",
              message:
                "./backdrop.css: images/bg.png is missing, larger than 4 MiB, a symlink, or outside the plugin folder.",
            },
          ]);
        }),
        {
          prepare: (pluginsDir) =>
            Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const path = yield* Path.Path;
              yield* fs.symlink(
                path.join(pluginsDir, "..", "outside"),
                path.join(pluginsDir, "backdrop", "images"),
              );
            }),
        },
      ),
  );

  it.effect("leaves out a plugin once enabled plugins embed more than 16 MiB in total", () => {
    const fourMegabytes = "x".repeat(4_000_000);
    const big = (name: string, files: ReadonlyArray<string>) => ({
      [`${name}/t3-plugin.json`]: JSON.stringify({
        ...LEAKY,
        id: `dev.example.${name}`,
        contributes: { styles: ["./big.css"] },
      }),
      [`${name}/big.css`]: files
        .map((file) => `.${file} { background: url(${file}.png); }`)
        .join(""),
      ...Object.fromEntries(files.map((file) => [`${name}/${file}.png`, fourMegabytes])),
    });
    return withEnvironmentPlugins(
      { ...big("first", ["a", "b"]), ...big("second", ["a", "b"]), ...big("third", ["a"]) },
      ["dev.example.first", "dev.example.second", "dev.example.third"],
      Effect.gen(function* () {
        const { plugins, problems } = yield* currentPlugins;
        assert.deepEqual(
          plugins.map((plugin) => [plugin.id, plugin.stylesheet !== undefined]),
          [
            ["dev.example.first", true],
            ["dev.example.second", true],
            ["dev.example.third", false],
          ],
        );
        assert.deepEqual(problems, [
          {
            directory: "third",
            message: "The files that enabled plugins embed add up to more than 16 MiB.",
          },
        ]);
      }),
    );
  });

  it.effect("recreates a deleted plugins folder and watches it again", () =>
    Effect.gen(function* () {
      const watches = yield* Queue.unbounded<{
        readonly install: Effect.Effect<void>;
        readonly end: Effect.Effect<void>;
      }>();
      const watch: FileSystem.FileSystem["watch"] = (_path, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const events = yield* Queue.unbounded<FileSystem.WatchEvent, Cause.Done>();
            const ended = yield* Deferred.make<void>();
            yield* Queue.offer(watches, {
              install: Effect.sync(() => options?.onReady?.()),
              end: Queue.end(events).pipe(Effect.andThen(Deferred.await(ended))),
            });
            return Stream.fromQueue(events).pipe(
              Stream.ensuring(Deferred.succeed(ended, undefined)),
            );
          }),
        );
      yield* withEnvironmentPlugins(
        BACKDROP_FILES,
        [],
        Effect.gen(function* () {
          const { pluginsDir } = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const seen = yield* collectChanges;
          assert.deepEqual(yield* Queue.take(seen), { plugins: [BACKDROP_LISTING], problems: [] });

          yield* fs.remove(pluginsDir, { recursive: true });
          yield* (yield* Queue.take(watches)).end;
          yield* TestClock.adjust("1 second");
          yield* (yield* Queue.take(watches)).install;
          assert.deepEqual(yield* Queue.take(seen), { plugins: [], problems: [] });
          assert.isTrue(yield* fs.exists(pluginsDir));
        }),
        { watch },
      );
    }),
  );

  it.effect("sends a plugin's stylesheet when settings enable it, but not for a value change", () =>
    withEnvironmentPlugins(
      BACKDROP_FILES,
      [],
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService.ServerSettingsService;
        const seen = yield* collectChanges;
        assert.deepEqual(yield* Queue.take(seen), { plugins: [BACKDROP_LISTING], problems: [] });

        yield* settings.updateSettings({
          plugins: { "dev.example.backdrop": { enabled: false, values: { sidebar: true } } },
        });
        yield* settings.updateSettings({
          plugins: { "dev.example.backdrop": { enabled: true, values: { sidebar: true } } },
        });
        assert.deepEqual(yield* Queue.take(seen), {
          plugins: [{ ...BACKDROP_LISTING, stylesheet: BACKDROP_STYLESHEET }],
          problems: [],
        });

        yield* settings.updateSettings({ plugins: { "dev.example.backdrop": null } });
        assert.deepEqual(yield* Queue.take(seen), { plugins: [BACKDROP_LISTING], problems: [] });
      }),
    ),
  );
});

it.live("reloads an enabled plugin when a file inside its folder is saved", () =>
  withEnvironmentPlugins(
    BACKDROP_FILES,
    ["dev.example.backdrop"],
    Effect.gen(function* () {
      const { pluginsDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const seen = yield* collectChanges;
      assert.equal((yield* Queue.take(seen)).plugins[0]?.stylesheet, BACKDROP_STYLESHEET);

      yield* fs.writeFileString(
        path.join(pluginsDir, "backdrop", "backdrop.css"),
        "body { color: red; }",
      );
      assert.equal((yield* Queue.take(seen)).plugins[0]?.stylesheet, "body { color: red; }");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
