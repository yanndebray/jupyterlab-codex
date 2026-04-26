"""Tornado handlers — same-origin proxy for the Codex Responses API plus
the device-code OAuth flow that powers "Sign in with ChatGPT" in the
browser.

Why a proxy at all? CORS. Both ``chatgpt.com/backend-api/codex/responses``
and ``auth.openai.com`` reject browser fetches from arbitrary origins.
Running the proxy inside the Jupyter server means the browser fetches
``/codex/...`` on the same origin Lab is served from — no cross-origin
preflight, no external infrastructure needed for the classic-Lab case.

JupyterLite users have no Python server to host these handlers — they
need an out-of-band proxy (e.g. a Netlify function) and must override
``codexProxyUrl`` in the extension settings to point at it.

Routes (all relative to the Jupyter ``base_url``):

  POST /codex
       Forwards the user's ``Authorization: Bearer <token>`` to OpenAI's
       Codex Responses API verbatim. The token never touches disk or
       logs here. Body is streamed as a buffered SSE response. (Same
       dispatch shape as the reference Netlify function so the same
       frontend can talk to either.)

  POST /codex/device/start
       Asks ``auth.openai.com/api/accounts/deviceauth/usercode`` for a
       user_code and returns it (plus the verification URL the user
       should visit) to the browser.

  POST /codex/device/poll
       Body: ``{device_auth_id, user_code}``. Polls the upstream
       ``/deviceauth/token`` endpoint; once it succeeds, immediately
       exchanges the returned authorization_code at ``/oauth/token`` for
       the real token bundle, parses ``chatgpt_account_id`` out of the
       id_token JWT, and returns ``{status: 'complete', bundle}``.
       While the user hasn't entered the code yet, returns
       ``{status: 'pending'}``.

  POST /codex/refresh
       Body: ``{refresh_token}``. Rotates the bundle via
       ``auth.openai.com/oauth/token`` (grant_type=refresh_token).

The ``client_id`` and verification-page URL match the Codex CLI's; we
reuse them because OpenAI does not publicly register OAuth clients with
Codex Responses scope. Same approach taken by ``opencode`` and
``openclaw``.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import tornado.httpclient
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

OPENAI_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
AUTH_BASE_URL = "https://auth.openai.com"
DEVICE_USERCODE_URL = f"{AUTH_BASE_URL}/api/accounts/deviceauth/usercode"
DEVICE_TOKEN_URL = f"{AUTH_BASE_URL}/api/accounts/deviceauth/token"
OAUTH_TOKEN_URL = f"{AUTH_BASE_URL}/oauth/token"
VERIFICATION_URL = f"{AUTH_BASE_URL}/codex/device"
# CLI client_id, baked into the open-source codex-rs login crate. Reused
# by every third-party tool that does ChatGPT-account auth (opencode,
# openclaw, …) because OpenAI doesn't expose registration for new ones.
CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
# /oauth/token wants this exact value; matches what the CLI uses for the
# device-code flow. NB: ``/deviceauth/callback``, NOT
# ``/api/accounts/deviceauth/callback`` — the CLI builds it from the bare
# issuer base, even though the polling endpoints sit under
# ``/api/accounts/``. See codex-rs/login/src/device_code_auth.rs:194.
DEVICE_REDIRECT_URI = f"{AUTH_BASE_URL}/deviceauth/callback"
USER_AGENT = "codex_cli_rs/0.0.0 (jupyterlab-codex proxy)"


def _decode_jwt_payload(jwt: str) -> dict[str, Any] | None:
    """Decode a JWT payload without verifying its signature.

    We only read ``chatgpt_account_id`` (under the
    ``https://api.openai.com/auth`` claim namespace). The upstream
    already verified the signature when issuing the token.
    """
    parts = jwt.split(".")
    if len(parts) < 2:
        return None
    b64 = parts[1].replace("-", "+").replace("_", "/")
    pad = b64 + "=" * (-len(b64) % 4)
    try:
        return json.loads(base64.b64decode(pad).decode("utf-8"))
    except Exception:
        return None


def _extract_account_id(id_token: str) -> str | None:
    claims = _decode_jwt_payload(id_token)
    if not claims:
        return None
    top = claims.get("chatgpt_account_id")
    if isinstance(top, str):
        return top
    ns = claims.get("https://api.openai.com/auth")
    if isinstance(ns, dict):
        nested = ns.get("chatgpt_account_id")
        if isinstance(nested, str):
            return nested
    return None


class _CodexHandler(APIHandler):
    """Base class — disables XSRF for the proxy routes.

    XSRF protection is meant to stop an attacker page from POSTing to a
    user's logged-in Jupyter server. Here that doesn't apply: every
    request needs a Bearer token the attacker can't forge, and the route
    only forwards opaque bytes upstream — there's no Jupyter-server state
    to mutate. Disabling the check lets the browser POST without first
    fetching ``/api/contents`` to prime the ``_xsrf`` cookie.
    """

    def check_xsrf_cookie(self) -> None:  # noqa: D401 - matches Tornado API
        return

    # We don't require a logged-in user — anyone with a valid bearer
    # token is allowed through. JupyterHub deployments can layer their
    # own auth on top via the standard ``--ServerApp.identity_provider``
    # mechanism if they need to.
    @property
    def login_handler(self):  # type: ignore[override]
        return None

    def _http_client(self) -> tornado.httpclient.AsyncHTTPClient:
        return tornado.httpclient.AsyncHTTPClient()

    async def _fetch(
        self,
        url: str,
        *,
        method: str = "POST",
        headers: dict[str, str] | None = None,
        body: bytes | str | None = None,
    ) -> tornado.httpclient.HTTPResponse:
        request = tornado.httpclient.HTTPRequest(
            url,
            method=method,
            headers=headers or {},
            body=body if body is not None else b"",
            request_timeout=300.0,
            allow_nonstandard_methods=True,
        )
        # raise_error=False so we forward the upstream status to the
        # caller instead of letting Tornado turn 4xx/5xx into HTTPError.
        return await self._http_client().fetch(request, raise_error=False)

    def write_json(self, status: int, payload: Any) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps(payload))


class CodexResponsesHandler(_CodexHandler):
    """POST /codex/responses — forward to OpenAI's Codex Responses API."""

    async def post(self) -> None:
        auth = self.request.headers.get("Authorization", "")
        if not auth.lower().startswith("bearer "):
            self.write_json(
                401,
                {
                    "error": (
                        "Missing Authorization: Bearer <token>. Sign in via "
                        "the JupyterLab Codex side panel before calling this "
                        "proxy."
                    )
                },
            )
            return
        try:
            upstream = await self._fetch(
                OPENAI_RESPONSES_URL,
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": auth,
                    # OpenAI's edge gates on User-Agent for some routes;
                    # spoofing the CLI's keeps us on the same code path.
                    "User-Agent": USER_AGENT,
                },
                body=self.request.body or b"",
            )
        except Exception as exc:  # noqa: BLE001 — surface to the client
            self.write_json(502, {"error": f"Upstream fetch failed: {exc}"})
            return

        self.set_status(upstream.code)
        self.set_header(
            "Content-Type",
            upstream.headers.get("Content-Type", "application/json"),
        )
        self.finish(upstream.body or b"")


class CodexDeviceStartHandler(_CodexHandler):
    """POST /codex/device/start — request a user_code from auth.openai.com."""

    async def post(self) -> None:
        try:
            upstream = await self._fetch(
                DEVICE_USERCODE_URL,
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps({"client_id": CODEX_CLIENT_ID}),
            )
        except Exception as exc:  # noqa: BLE001
            self.write_json(502, {"error": f"Upstream fetch failed: {exc}"})
            return

        text = (upstream.body or b"").decode("utf-8", errors="replace")
        if upstream.code >= 400:
            self.write_json(
                upstream.code,
                {"error": f"Device-auth start failed: {text[:300]}"},
            )
            return
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            self.write_json(
                502, {"error": f"Device-auth start: bad JSON: {text[:200]}"}
            )
            return

        interval = parsed.get("interval", 5)
        try:
            interval = int(interval)
        except (TypeError, ValueError):
            interval = 5
        self.write_json(
            200,
            {
                "device_auth_id": parsed.get("device_auth_id"),
                "user_code": parsed.get("user_code"),
                "verification_uri": VERIFICATION_URL,
                "interval": interval,
                "expires_at": parsed.get("expires_at"),
            },
        )


class CodexDevicePollHandler(_CodexHandler):
    """POST /codex/device/poll — poll for token + exchange the auth code."""

    async def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except json.JSONDecodeError:
            self.write_json(400, {"error": "Invalid JSON body"})
            return
        device_auth_id = body.get("device_auth_id")
        user_code = body.get("user_code")
        if not device_auth_id or not user_code:
            self.write_json(
                400,
                {"error": "device_auth_id and user_code are required"},
            )
            return

        try:
            poll_resp = await self._fetch(
                DEVICE_TOKEN_URL,
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps(
                    {
                        "device_auth_id": device_auth_id,
                        "user_code": user_code,
                    }
                ),
            )
        except Exception as exc:  # noqa: BLE001
            self.write_json(502, {"error": f"Device-auth poll failed: {exc}"})
            return

        # The CLI treats 403 and 404 as "still pending" (the user hasn't
        # entered the code yet, or the upstream is briefly forgetful
        # between submission and propagation). Anything else non-2xx is
        # a hard failure.
        if poll_resp.code in (403, 404):
            self.write_json(200, {"status": "pending"})
            return
        text = (poll_resp.body or b"").decode("utf-8", errors="replace")
        if poll_resp.code >= 400:
            self.write_json(
                poll_resp.code,
                {"error": f"Device-auth poll failed: {text[:300]}"},
            )
            return
        try:
            code_resp = json.loads(text)
        except json.JSONDecodeError:
            self.write_json(
                502, {"error": f"Device-auth poll: bad JSON: {text[:200]}"}
            )
            return
        authorization_code = code_resp.get("authorization_code")
        code_verifier = code_resp.get("code_verifier")
        if not authorization_code or not code_verifier:
            self.write_json(
                502,
                {
                    "error": (
                        "Device-auth poll: response missing "
                        "authorization_code/code_verifier"
                    )
                },
            )
            return

        # Exchange the authorization_code for the real token bundle.
        # Upstream wants form-urlencoded, not JSON.
        form = urlencode(
            {
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": DEVICE_REDIRECT_URI,
                "client_id": CODEX_CLIENT_ID,
                "code_verifier": code_verifier,
            }
        )
        try:
            token_resp = await self._fetch(
                OAUTH_TOKEN_URL,
                method="POST",
                headers={
                    "Content-Type": "application/x-www-form-urlencoded"
                },
                body=form,
            )
        except Exception as exc:  # noqa: BLE001
            self.write_json(502, {"error": f"Token exchange failed: {exc}"})
            return
        token_text = (token_resp.body or b"").decode("utf-8", errors="replace")
        if token_resp.code >= 400:
            self.write_json(
                token_resp.code,
                {"error": f"Token exchange failed: {token_text[:300]}"},
            )
            return
        try:
            tokens = json.loads(token_text)
        except json.JSONDecodeError:
            self.write_json(
                502,
                {"error": f"Token exchange: bad JSON: {token_text[:200]}"},
            )
            return
        if not all(
            tokens.get(k) for k in ("access_token", "id_token", "refresh_token")
        ):
            self.write_json(
                502, {"error": "Token exchange: response missing tokens"}
            )
            return
        account_id = _extract_account_id(tokens["id_token"])
        self.write_json(
            200,
            {
                "status": "complete",
                "bundle": {
                    "tokens": {
                        "id_token": tokens["id_token"],
                        "access_token": tokens["access_token"],
                        "refresh_token": tokens["refresh_token"],
                        "account_id": account_id,
                    },
                    "last_refresh": datetime.now(timezone.utc).isoformat(),
                },
            },
        )


class CodexRefreshHandler(_CodexHandler):
    """POST /codex/refresh — rotate the token bundle.

    Refresh tokens are rotated by the upstream — callers must replace
    their stored ``refresh_token`` with the new one. Reusing an old
    refresh token is a permanent failure on OpenAI's side.
    """

    async def post(self) -> None:
        try:
            body = json.loads(self.request.body or b"{}")
        except json.JSONDecodeError:
            self.write_json(400, {"error": "Invalid JSON body"})
            return
        refresh_token = body.get("refresh_token")
        if not refresh_token:
            self.write_json(400, {"error": "refresh_token is required"})
            return
        try:
            upstream = await self._fetch(
                OAUTH_TOKEN_URL,
                method="POST",
                headers={"Content-Type": "application/json"},
                body=json.dumps(
                    {
                        "client_id": CODEX_CLIENT_ID,
                        "grant_type": "refresh_token",
                        "refresh_token": refresh_token,
                        "scope": "openid profile email",
                    }
                ),
            )
        except Exception as exc:  # noqa: BLE001
            self.write_json(502, {"error": f"Refresh failed: {exc}"})
            return
        text = (upstream.body or b"").decode("utf-8", errors="replace")
        if upstream.code >= 400:
            self.write_json(
                upstream.code,
                {"error": f"Refresh failed: {text[:300]}"},
            )
            return
        try:
            tokens = json.loads(text)
        except json.JSONDecodeError:
            self.write_json(
                502, {"error": f"Refresh: bad JSON: {text[:200]}"}
            )
            return
        if not all(
            tokens.get(k) for k in ("access_token", "id_token", "refresh_token")
        ):
            self.write_json(
                502, {"error": "Refresh: response missing tokens"}
            )
            return
        account_id = _extract_account_id(tokens["id_token"])
        self.write_json(
            200,
            {
                "tokens": {
                    "id_token": tokens["id_token"],
                    "access_token": tokens["access_token"],
                    "refresh_token": tokens["refresh_token"],
                    "account_id": account_id,
                },
                "last_refresh": datetime.now(timezone.utc).isoformat(),
            },
        )


def setup_handlers(web_app) -> None:
    """Register Codex proxy routes on the Jupyter server's web app."""
    base = web_app.settings["base_url"]
    web_app.add_handlers(
        ".*$",
        [
            # More specific patterns first — Tornado anchors patterns with
            # ``$``, so ``/codex`` won't shadow ``/codex/device/start``,
            # but listing the children first reads better and is robust
            # to future URLSpec changes.
            (
                url_path_join(base, "codex", "device", "start"),
                CodexDeviceStartHandler,
            ),
            (
                url_path_join(base, "codex", "device", "poll"),
                CodexDevicePollHandler,
            ),
            (url_path_join(base, "codex", "refresh"), CodexRefreshHandler),
            (url_path_join(base, "codex"), CodexResponsesHandler),
        ],
    )
