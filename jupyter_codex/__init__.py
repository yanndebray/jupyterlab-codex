"""jupyter_codex — JupyterLab extension exposing OpenAI Codex in a side panel.

In classic JupyterLab the Python package serves two roles:

  1. Ships the prebuilt frontend assets (see ``_jupyter_labextension_paths``).
  2. Registers a Tornado server extension at ``/codex/...`` that proxies
     to OpenAI on behalf of the browser, sidestepping CORS.

In JupyterLite the Python package isn't loaded at all (the runtime is
Pyodide, not CPython). The frontend assets still work, but the proxy
needs to be hosted out-of-band and ``codexProxyUrl`` overridden to point
at it. See README for both deployment recipes.
"""

from ._version import __version__


# Server extension is optional — not available in JupyterLite/Pyodide,
# where jupyter_server is not installed. The frontend labextension works
# in both environments.
try:
    from .handlers import setup_handlers as _setup_handlers
except ImportError:
    _setup_handlers = None


def _jupyter_labextension_paths():
    """Return the JupyterLab prebuilt extension path."""
    return [{"src": "labextension", "dest": "jupyterlab-codex"}]


def _jupyter_server_extension_points():
    """Declare this module as a Jupyter server extension."""
    return [{"module": "jupyter_codex"}]


def _load_jupyter_server_extension(server_app) -> None:
    """Register Codex proxy routes with the Jupyter server."""
    if _setup_handlers is None:
        server_app.log.warning(
            "jupyter_codex: jupyter_server not available; "
            "skipping proxy routes (expected in JupyterLite)."
        )
        return
    _setup_handlers(server_app.web_app)
    server_app.log.info("Registered jupyter_codex server extension")


# Backwards-compatible alias for older jupyter_server releases.
load_jupyter_server_extension = _load_jupyter_server_extension


__all__ = ["__version__"]
