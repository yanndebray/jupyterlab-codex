# jupyterlab-codex

A JupyterLab 4 extension that adds an **OpenAI Codex** chat panel to the
left sidebar. The OpenAI mark serves as the sidebar tab icon.

## Scope: notebook copilot, not project agent

This is a deliberately small tool. The agent can only:

- list variables in your notebook kernel
- describe a pandas DataFrame
- run short Python snippets in the kernel
- read the source / outputs of a selected cell or a cell by execution count
- insert (and optionally run) a new code cell below the active one

That's the complete tool surface. **No filesystem read/write. No shell.
No MCP. No project-wide context.** The agent sees what's in your kernel
and your active notebook — nothing else.

This is a feature, not a limitation. Claude Code, Cursor, and the Codex
CLI itself are excellent project agents — they edit files, run tests,
manage git. Use them for that. `jupyterlab-codex` is for the inner
loop *inside* a notebook: explain this cell, evaluate this model,
describe this DataFrame, write the next cell. It runs where your
exploratory work already lives, with zero context-switch and a live
view of kernel state.

If you find yourself wishing it could grep your repo, that's a sign you
want a different tool — and you almost certainly already have one open
in another window.

Authentication uses the user's ChatGPT subscription via OAuth (the same
flow the Codex CLI uses). Tokens live in `localStorage` and are
forwarded to a small proxy that talks to the Codex Responses API.

## Two deployment modes

The extension needs a **proxy** because both
`chatgpt.com/backend-api/codex/responses` and `auth.openai.com` reject
browser fetches from arbitrary origins. Where the proxy lives depends on
how you're running JupyterLab.

### Classic JupyterLab — bundled, no external infra

`pip install jupyterlab-codex` ships a Tornado server extension that
proxies to OpenAI from same-origin. The browser fetches `/codex` and
`/codex/device/...` on whichever host the Jupyter server is exposed on
— no CORS, no third-party services.

```bash
pip install jupyterlab-codex     # (or pip install -e . for dev)
jupyter lab
```

Open the OpenAI mark in the left sidebar and click **Sign in with
ChatGPT**. That's it.

| Setting | Default | Notes |
|---|---|---|
| `codexProxyUrl` | `codex` | Resolved against the Jupyter base URL → `<base>/codex` |
| `codexModel` | `gpt-5.3-codex` | Must be a model your ChatGPT account is entitled to |

The bundled handlers live under the Jupyter `base_url`:

```
POST  <base>/codex                  → forwards Responses API call upstream
POST  <base>/codex/device/start     → request a device code
POST  <base>/codex/device/poll      → poll for completion + token exchange
POST  <base>/codex/refresh          → rotate the refresh_token
```

### JupyterLite — external proxy required

In JupyterLite there is **no Python server** (the kernel runs in
Pyodide, the page is static). The Python package isn't installed, so
the bundled proxy can't run. Host a proxy out-of-band and override
`codexProxyUrl` to point at it.

The reference implementation is the Netlify function in the
[`jupyterlab-skore`](https://github.com/yanndebray/jupyterlab-skore)
project (`netlify/functions/codex.ts`) — exposes the same four routes
with the same dispatch shape, so it's a drop-in. Cloudflare Workers,
AWS Lambda, or a self-hosted FastAPI service work equally well as long
as they implement:

```
POST  <proxy>                       → forwards Responses API call upstream
POST  <proxy>/device/start
POST  <proxy>/device/poll
POST  <proxy>/refresh
```

Then in **Settings → jupyterlab-codex** set
`codexProxyUrl` to the proxy URL (e.g. `/.netlify/functions/codex` if
the proxy is co-hosted on the lite site, or
`https://my-proxy.example.com/codex` if it's elsewhere).

## URL resolution

`codexProxyUrl` is interpreted as follows:

| Value | Resolved to |
|---|---|
| `"codex"` (default) | `<jupyter-base-url>/codex` |
| `"/foo/bar"` | `/foo/bar` (absolute path on current origin) |
| `"https://x.com/y"` | used as-is |
| `""` | `<jupyter-base-url>/codex` |

This lets the same default work in classic Lab (hits the bundled server
extension), single-user JupyterHub (`<base>` becomes `/user/<name>/`),
and JupyterLite (user picks an absolute path or a full URL).

## Install for development

```bash
pip install -e ".[dev]"
jupyter labextension develop . --overwrite
jlpm build
```

`jlpm watch` rebuilds the labextension on change; refresh Lab to pick up
TypeScript changes.

## Project layout

```
src/
  index.ts              # plugin entry point — registers the sidebar
  widget.ts             # Lumino widget — chat UI + sign-in flow
  icon.ts               # OpenAI mark for the sidebar tab
  kernelRpc.ts          # run-Python + sentinel-parsing primitive
  agent/
    client.ts           # tool-use loop driver
    codexAuth.ts        # localStorage auth + device-code login
    codexProvider.ts    # Codex Responses API client (Anthropic-shape adapter)
    proxyUrl.ts         # codexProxyUrl resolution helper
    tools.ts            # kernel-side tool schemas + Python prelude
    toolRunner.ts       # injects prelude, parses sentinel-wrapped JSON
    frontendTools.ts    # browser-side tools (insert_cell, get_cell_context, …)
    transcriptStore.ts  # persists chat to .jupyterlab-codex-chat.json
    markdown.ts         # tiny markdown → HTML renderer
schema/plugin.json      # ISettingRegistry schema
style/                  # sidebar + chat CSS, OpenAI SVG mark
jupyterlab_codex/
  __init__.py           # labextension paths + server-extension entry points
  handlers.py           # Tornado proxy: /codex, /codex/device/*, /codex/refresh
jupyter-config/         # auto-enables the server extension on install
```
