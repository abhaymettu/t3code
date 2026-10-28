# Plugins

A plugin changes how T3 Code looks or which optional pieces it shows. It is a folder with a
`t3-plugin.json` file, one or more stylesheets, and any images or fonts they use. Plugins do not run
code, and installing one does not change or re-sign the app, so updates keep working.

Plugins work on desktop and in the browser. The mobile app does not use them.

## Install a plugin

1. Copy the plugin's folder into `~/.t3/userdata/plugins/` on the machine that runs T3 Code, or the
   `plugins` directory under your custom state directory.
2. Open **Settings → Plugins** and turn the plugin on.

Its settings appear under its name once it is on. Changes apply as you make them.

Like environment themes, plugins come from the server serving your web app or the desktop app's main
local environment, and the choices you make apply to every client of that environment. Turning a
plugin on needs permission to change that environment's settings.

To remove a plugin, turn it off or delete its folder.

If a plugin cannot load, **Settings → Plugins** names its folder and the reason, and nothing from it is
applied.

## Write a plugin

Two complete examples live in
[`examples/plugins`](https://github.com/pingdotgg/t3code/tree/main/examples/plugins): a picture behind
the window, and switches that hide thread details sections. Copy one into your plugins folder to start.
T3 Code reloads a plugin when you save any of its files. A plugin folder that is a symlink to somewhere
else does not reload on save; turn the plugin off and on to reload it.

### The manifest

```json
{
  "manifestVersion": 1,
  "id": "example.backdrop",
  "version": "1.0.0",
  "apiVersion": 1,
  "name": "Backdrop",
  "description": "A picture behind the whole window.",
  "contributes": {
    "styles": ["./backdrop.css"],
    "settings": [
      {
        "type": "range",
        "key": "fade",
        "title": "Fade",
        "min": 30,
        "max": 95,
        "step": 1,
        "unit": "%",
        "default": 72
      }
    ]
  }
}
```

- `id` is two or more parts joined by dots, such as `yourname.backdrop`, up to 128 characters. Each part
  uses lowercase letters, digits, and single dashes, and cannot start or end with a dash. The ID names
  the plugin's settings and CSS hooks, so keep it stable.
- `styles` lists up to 8 stylesheets, as paths that start with `./`.
- `settings` lists up to 32 settings. Each has a `key`, a `title`, an optional `description`, and a
  `default`. A `key` starts with a lowercase letter, then uses lowercase letters, digits, and single
  dashes, up to 48 characters, and cannot end with a dash. Menu option values follow the same rule.
  - `boolean` shows a switch.
  - `select` shows a menu of `options`, each `{ "value": "...", "label": "..." }`.
  - `range` shows a slider from `min` to `max` in steps of `step`, with an optional `unit` of `%`, `px`,
    `ms`, or `deg`.

A manifest with any other field, or larger than 32 KiB, does not load. T3 Code reads at most 32 plugin
folders.

### Scope your rules

While a plugin is on, the root element carries `data-plugin-` followed by its ID with dots as
underscores, such as `data-plugin-example_backdrop`. Start your selectors with it. Your rules then apply only while
the plugin is on, and they outrank the theme's own rules:

```css
:root[data-plugin-example_backdrop] [data-chat-header] {
  background-color: transparent;
}
```

### Use settings in CSS

Each setting is available on the root element as a custom property, and switches and menus also as an
attribute. The name is the plugin's root name, two dashes, and the setting key:

| Setting                                | Custom property                         | Attribute                                      |
| -------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `example.backdrop`, range `fade` at 72 | `--plugin-example_backdrop--fade: 72%`  | None                                           |
| boolean `sidebar` on                   | `--plugin-example_backdrop--sidebar: 1` | `data-plugin-example_backdrop--sidebar="true"` |
| select `focus` at `top`                | `--plugin-example_backdrop--focus: top` | `data-plugin-example_backdrop--focus="top"`    |

```css
:root[data-plugin-example_backdrop--sidebar="true"] [data-slot="sidebar-inner"] {
  background-color: transparent;
}
```

### What stylesheets can use

- Files in the plugin's own folder, with `url("./image.png")`. PNG, JPEG, WebP, GIF, AVIF, and
  WOFF2 work. Each file can be up to 4 MiB, the files one plugin uses up to 8 MiB, and the files all
  enabled plugins use up to 16 MiB together. A plugin that would go over the total does not load.
- `data:` URLs of those same types, such as `data:image/png;base64,...`.

Each stylesheet can be up to 256 KiB. These stop a plugin from loading:

- `@import`, `src()`, `image-set()`, and `-webkit-image-set()`.
- SVG, as a file or a `data:` URL. An SVG can load other files when used as a filter or mask.
- A `url()` with a web address, a path that starts with `/`, or a path that leaves the plugin folder.
- A file name with characters other than letters, digits, `_`, `.`, `/`, and `-`, which also rules out
  `?` queries and `#` fragments.

Select elements by the theme's CSS variables and by the `data-` attributes T3 Code documents:
`data-slot`, `data-sidebar`, `data-workspace-area`, `data-chat-layout`, `data-chat-column`,
`data-chat-header`, `data-timeline-root`, `data-chat-composer-form`, `data-thread-details-card`, and
`data-thread-details-section`. Match them by attribute, not by their position in the page. Class names
change often and are not supported.

Avoid animations that run continuously. They keep the display repainting and cost battery.
