// Resolve a configured ``codexProxyUrl`` to a fully-qualified URL the
// browser can fetch.
//
//   - If it starts with ``http://`` or ``https://``, it's a full URL —
//     use it as-is. (Used by deployments that point JupyterLite at a
//     proxy hosted on a different origin.)
//   - If it starts with ``/``, it's an absolute path on the current
//     origin — use it as-is. (Used by JupyterLite + Netlify, where the
//     proxy is at ``/.netlify/functions/codex`` on the same origin as
//     the static lite bundle.)
//   - Otherwise, treat it as relative to the Jupyter server's base URL
//     (e.g. ``"codex"`` → ``http://localhost:8888/codex``). This is the
//     classic-Lab default — it talks to the bundled server extension.

import { PageConfig, URLExt } from '@jupyterlab/coreutils';

export function resolveProxyUrl(configured: string): string {
  if (!configured) {
    return URLExt.join(PageConfig.getBaseUrl(), 'codex');
  }
  if (/^https?:\/\//i.test(configured)) {
    return configured;
  }
  if (configured.startsWith('/')) {
    return configured;
  }
  return URLExt.join(PageConfig.getBaseUrl(), configured);
}
