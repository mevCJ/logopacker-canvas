# logopacker-canvas

This template should help get you started developing with Vue 3 in Vite.

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Type Support for `.vue` Imports in TS

TypeScript cannot handle type information for `.vue` imports by default, so we replace the `tsc` CLI with `vue-tsc` for type checking. In editors, we need [Volar](https://marketplace.visualstudio.com/items?itemName=Vue.volar) to make the TypeScript language service aware of `.vue` types.

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Type-Check, Compile and Minify for Production

```sh
npm run build
```

## Agent-Native Vector Canvas (NOVA)

This app hosts an agent-native vector design canvas at `/` (also `/canvas`). A human
edits an SVG-based canvas while an external WebMCP agent operates the same canvas
through tools registered via `document.modelContext.registerTool`.

### Structure

- `src/stores/canvas.ts` — Pinia store, the single source of truth (artboards, objects,
  selection, snapshot/undo history, agent activity log).
- `src/services/canvas/svgEngine.ts` — SVG.js renderer + pure geometry helpers.
- `src/services/canvas/novaSeed.ts` — seeds the demo NOVA logo from
  `src/assets/logoipsum.svg` (imported with `?raw`), tagged with semantic roles.
- `src/services/canvas/tools.ts` + `imageTextTools.ts` — WebMCP tool definitions
  (inspection, object mutation, typography, Pexels images, handoff orchestration).
- `src/components/canvas/*` — Toolbar, CanvasStage, PropertyPanel, AgentActivityLog.
- `src/views/CanvasView.vue` — mounts the canvas, seeds the logo, registers the tools.
- `server/pexels.ts` + `server/index.ts` — the Cloudflare Worker proxies Pexels image
  search at `/api/pexels/search`, keeping the API key server-side.

### Tests

```sh
npm run test
```

### Pexels API key

The Pexels proxy reads `PEXELS_API_KEY` from the Worker environment.

- Local development (`npm run dev` / `wrangler dev`): put it in `.dev.vars`
  (see `.dev.vars.example`). `.dev.vars` is gitignored.
- Production (`npm run deploy`): set it as a secret, not a plaintext var:

  ```sh
  npx wrangler secret put PEXELS_API_KEY
  ```

### Routing

The Worker runs first only for `/api/*` (see `run_worker_first` in `wrangler.jsonc`);
all other routes are served by static assets with single-page-application fallback,
so client-side routes like `/canvas` resolve correctly.
