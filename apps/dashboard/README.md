# Dashboard

Start the standalone demo from the repository root:

```powershell
pnpm demo:dashboard
# Or directly, without the package manager:
node tools/dashboard-preview.mjs
```

Open the printed URL, normally `http://127.0.0.1:4321/?fixture=demo`.
The preview root redirects to the demo. No database, Temporal, connector
credentials, or model services are required. Demo settings use separate local
storage keys from connected-workspace settings. Refreshing the demo does not call
backend APIs. Set `ODA_DASHBOARD_PORT` to change the port.

The connected application is served by the API; the preview serves synthetic
data. `?fixture=performance&diagnostic=1` runs the rendering diagnostic.

## Source layout

| File                    | Responsibility                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `index.html`            | Semantic page structure and accessible controls                  |
| `styles/dashboard.css`  | Theme, layout, animation, responsive and reduced-motion rules    |
| `dashboard.js`          | Rendering, decisions, selection, and execution updates           |
| `core.js`               | Shared state, preferences, DOM helpers, and session headers      |
| `demo.js`               | Synthetic tasks, activity, and telemetry                         |
| `settings.js`           | Settings, profile/connector configuration, and spending controls |
| `telemetry.js`          | Charts, filters, contributions, and task/step drill-down         |
| `particles.js`          | Particle animation and lifecycle                                 |
| `workspace-controls.js` | Reusable workspace/settings control construction                 |
| `assets.json`           | Asset allowlist and MIME types shared by API and preview         |

Static styles belong in the stylesheet. JavaScript sets data-dependent values
such as progress widths and animation delays. Both servers use the same asset
manifest, so module imports cannot accidentally receive an HTML fallback.
