// Sidebar widget — a single chat panel that talks to OpenAI Codex.
//
// The widget is a plain Lumino Widget (no React dependency). It owns the
// chat transcript, sign-in flow, and the agent loop driver.

import { INotebookTracker } from '@jupyterlab/notebook';
import { Contents } from '@jupyterlab/services';
import { Widget } from '@lumino/widgets';
import { renderMarkdown } from './agent/markdown';
import { runAgentLoop, IMessage, IProviderConfig } from './agent/client';
import { TranscriptStore } from './agent/transcriptStore';
import {
  clearCodexAuth,
  describeAuth,
  loadCodexAuth,
  parsePastedAuth,
  pollDeviceLogin,
  saveCodexAuth,
  startDeviceLogin
} from './agent/codexAuth';
import { codexIcon } from './icon';

export interface ICodexSettings {
  codexModel: string;
  codexProxyUrl: string;
}

const DEFAULT_SETTINGS: ICodexSettings = {
  codexModel: 'gpt-5.3-codex',
  // Relative path → resolved against the Jupyter server's base URL by
  // resolveProxyUrl(); hits the bundled server extension. JupyterLite
  // users override this in Settings to point at an external proxy.
  codexProxyUrl: 'codex'
};

interface IAgentEntry {
  kind: 'user' | 'assistant-text' | 'tool';
  html: string;
}

export class CodexSidebarWidget extends Widget {
  private content: HTMLElement;
  private agentEntries: IAgentEntry[] = [];
  private agentMessages: IMessage[] = [];
  private notebookTracker: INotebookTracker | null;
  private transcriptStore: TranscriptStore | null = null;
  private transcriptLoaded = false;

  private settings: ICodexSettings = { ...DEFAULT_SETTINGS };

  constructor(
    notebookTracker: INotebookTracker | null = null,
    contents: Contents.IManager | null = null
  ) {
    super();
    this.notebookTracker = notebookTracker;
    this.transcriptStore = contents ? new TranscriptStore(contents) : null;
    this.id = 'jupyterlab-codex-sidebar';
    this.title.caption = 'OpenAI Codex';
    this.title.icon = codexIcon;
    // No title.label — let the icon stand alone in the sidebar rail.
    this.addClass('jp-codex-sidebar');

    const root = document.createElement('div');
    root.className = 'jp-codex-root';

    this.content = document.createElement('div');
    this.content.className = 'jp-codex-content';

    root.appendChild(this.content);
    this.node.appendChild(root);

    this.render();
  }

  /** Inject settings loaded from the JupyterLab ISettingRegistry. */
  public setSettings(settings: Partial<ICodexSettings>): void {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.render();
  }

  private render(): void {
    this.content.textContent = '';
    this.renderAgent();
  }

  private renderAgent(): void {
    const box = document.createElement('div');
    box.className = 'jp-codex-agent';

    const header = document.createElement('div');
    header.className = 'jp-codex-agent-header';

    const intro = document.createElement('p');
    intro.className = 'jp-codex-agent-intro';
    intro.textContent =
      'Ask Codex about your notebook. It can inspect kernel variables, ' +
      'read selected cells, and insert new code.';
    header.appendChild(intro);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'jp-codex-agent-clear';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear chat history';
    header.appendChild(clearBtn);
    box.appendChild(header);

    // Provider bar: shows the model and (for ChatGPT auth) sign-in state.
    const providerBar = document.createElement('div');
    providerBar.className = 'jp-codex-agent-provider';
    const renderProviderBar = (): void => this.renderProviderBar(providerBar);
    renderProviderBar();
    box.appendChild(providerBar);

    const transcript = document.createElement('div');
    transcript.className = 'jp-codex-agent-transcript';
    for (const entry of this.agentEntries) {
      transcript.appendChild(this.createEntryElement(entry));
    }
    box.appendChild(transcript);

    clearBtn.addEventListener('click', async () => {
      this.agentEntries = [];
      this.agentMessages = [];
      transcript.textContent = '';
      await this.transcriptStore?.clear();
    });

    if (this.transcriptStore && !this.transcriptLoaded) {
      this.transcriptLoaded = true;
      void this.transcriptStore.load().then(bundle => {
        if (!bundle || bundle.entries.length === 0) return;
        if (this.agentEntries.length > 0) return;
        this.agentEntries = bundle.entries;
        this.agentMessages = bundle.messages;
        for (const entry of bundle.entries) {
          transcript.appendChild(this.createEntryElement(entry));
        }
        transcript.scrollTop = transcript.scrollHeight;
      });
    }

    const form = document.createElement('form');
    form.className = 'jp-codex-agent-form';

    const textarea = document.createElement('textarea');
    textarea.className = 'jp-codex-agent-input';
    textarea.placeholder = 'e.g. Explain the selected cell';
    textarea.rows = 3;
    form.appendChild(textarea);

    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'jp-codex-agent-send';
    sendBtn.textContent = 'Ask';
    form.appendChild(sendBtn);

    const appendEntry = (entry: IAgentEntry): HTMLElement => {
      this.agentEntries.push(entry);
      const el = this.createEntryElement(entry);
      transcript.appendChild(el);
      transcript.scrollTop = transcript.scrollHeight;
      return el;
    };

    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const question = textarea.value.trim();
      if (!question) return;

      appendEntry({ kind: 'user', html: renderMarkdown(question) });
      this.agentMessages.push({ role: 'user', content: question });

      textarea.value = '';
      sendBtn.disabled = true;
      textarea.disabled = true;

      const loading = document.createElement('div');
      loading.className = 'jp-codex-agent-msg jp-codex-agent-msg-loading';
      loading.textContent = 'Thinking…';
      transcript.appendChild(loading);
      transcript.scrollTop = transcript.scrollHeight;

      const kernel =
        this.notebookTracker?.currentWidget?.sessionContext?.session
          ?.kernel ?? null;

      const provider = this.buildProviderConfig();
      if (!provider) {
        loading.remove();
        appendEntry({
          kind: 'assistant-text',
          html:
            '<p><em>Not signed in. Use the Sign in or Import buttons above.</em></p>'
        });
        sendBtn.disabled = false;
        textarea.disabled = false;
        textarea.focus();
        return;
      }

      try {
        await runAgentLoop(
          this.agentMessages,
          kernel,
          this.notebookTracker,
          provider,
          {
            onAssistantText: text => {
              loading.remove();
              appendEntry({
                kind: 'assistant-text',
                html: renderMarkdown(text)
              });
            },
            onToolStart: (name, input) => {
              loading.remove();
              appendEntry({
                kind: 'tool',
                html: this.renderToolCard(name, input, null, 'running')
              });
            },
            onToolResult: (name, input, result, ok) => {
              const last = this.agentEntries[this.agentEntries.length - 1];
              if (last?.kind === 'tool') {
                last.html = this.renderToolCard(
                  name,
                  input,
                  result,
                  ok ? 'ok' : 'error'
                );
                const lastEl = transcript.lastElementChild as HTMLElement;
                if (lastEl) lastEl.innerHTML = last.html;
              }
            },
            onError: msg => {
              loading.remove();
              appendEntry({
                kind: 'assistant-text',
                html: `<p><em>Error: ${this.escapeHtml(msg)}</em></p>`
              });
            },
            onWarning: msg => {
              appendEntry({
                kind: 'assistant-text',
                html: `<p class="jp-codex-agent-notice">⚠ ${this.escapeHtml(msg)}</p>`
              });
            },
            onDone: () => {
              loading.remove();
              void this.transcriptStore?.save(
                this.agentEntries,
                this.agentMessages
              );
            }
          }
        );
      } catch (err) {
        loading.remove();
        appendEntry({
          kind: 'assistant-text',
          html: `<p><em>Request failed: ${this.escapeHtml((err as Error).message)}</em></p>`
        });
      } finally {
        sendBtn.disabled = false;
        textarea.disabled = false;
        textarea.focus();
        transcript.scrollTop = transcript.scrollHeight;
      }
    });

    box.appendChild(form);
    this.content.appendChild(box);
    setTimeout(() => textarea.focus(), 0);
  }

  /**
   * Build the provider config from current settings + persisted Codex auth.
   * Returns null when the user isn't signed in.
   */
  private buildProviderConfig(): IProviderConfig | null {
    const auth = loadCodexAuth();
    if (!auth) return null;
    return {
      endpoint: this.settings.codexProxyUrl,
      model: this.settings.codexModel,
      auth
    };
  }

  private renderProviderBar(host: HTMLElement): void {
    host.textContent = '';

    const auth = loadCodexAuth();
    const status = document.createElement('span');
    status.className = 'jp-codex-agent-provider-status';
    status.textContent = describeAuth(auth);
    host.appendChild(status);

    const modelTag = document.createElement('span');
    modelTag.className = 'jp-codex-agent-provider-model';
    modelTag.textContent = this.settings.codexModel;
    modelTag.title = 'Codex model (change in JupyterLab Settings → jupyterlab-codex)';
    host.appendChild(modelTag);

    const refresh = (): void => this.renderProviderBar(host);

    if (auth) {
      const signOut = document.createElement('button');
      signOut.type = 'button';
      signOut.className = 'jp-codex-agent-provider-btn';
      signOut.textContent = 'Sign out';
      signOut.addEventListener('click', () => {
        clearCodexAuth();
        refresh();
      });
      host.appendChild(signOut);
      return;
    }

    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'jp-codex-agent-provider-btn';
    signIn.textContent = 'Sign in with ChatGPT';
    signIn.addEventListener('click', async () => {
      signIn.disabled = true;
      try {
        await this.runDeviceCodeLogin(status);
        refresh();
      } catch (err) {
        status.textContent = `Sign-in failed: ${(err as Error).message}`;
      } finally {
        signIn.disabled = false;
      }
    });
    host.appendChild(signIn);

    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'jp-codex-agent-provider-btn';
    importBtn.textContent = 'Import auth.json';
    importBtn.title =
      'Paste the contents of ~/.codex/auth.json from a machine where ' +
      '`codex login` has already run.';
    importBtn.addEventListener('click', () => {
      const pasted = window.prompt(
        'Paste the contents of ~/.codex/auth.json:'
      );
      if (!pasted) return;
      try {
        const bundle = parsePastedAuth(pasted);
        saveCodexAuth(bundle);
        refresh();
      } catch (err) {
        status.textContent = `Import failed: ${(err as Error).message}`;
      }
    });
    host.appendChild(importBtn);
  }

  private async runDeviceCodeLogin(status: HTMLElement): Promise<void> {
    status.textContent = 'Requesting device code…';
    const start = await startDeviceLogin(this.settings.codexProxyUrl);

    const overlay = document.createElement('div');
    overlay.className = 'jp-codex-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'jp-codex-modal';
    overlay.appendChild(modal);

    const heading = document.createElement('h3');
    heading.textContent = 'Sign in with ChatGPT';
    modal.appendChild(heading);

    const stepOne = document.createElement('p');
    stepOne.innerHTML =
      '1. Open <a target="_blank" rel="noopener noreferrer" href="' +
      this.escapeHtml(start.verification_uri) +
      '">' +
      this.escapeHtml(start.verification_uri) +
      '</a> and sign in.';
    modal.appendChild(stepOne);

    const stepTwo = document.createElement('p');
    stepTwo.textContent = '2. Enter this one-time code:';
    modal.appendChild(stepTwo);

    const codeBox = document.createElement('div');
    codeBox.className = 'jp-codex-modal-code';
    codeBox.textContent = start.user_code;
    codeBox.title = 'Click to copy';
    codeBox.addEventListener('click', () => {
      void navigator.clipboard?.writeText(start.user_code);
      codeBox.classList.add('jp-codex-modal-code-copied');
      window.setTimeout(
        () => codeBox.classList.remove('jp-codex-modal-code-copied'),
        800
      );
    });
    modal.appendChild(codeBox);

    const note = document.createElement('p');
    note.className = 'jp-codex-modal-note';
    note.textContent =
      'Waiting for approval… Device codes are a common phishing target — never share this code.';
    modal.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'jp-codex-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    actions.appendChild(cancel);
    modal.appendChild(actions);

    document.body.appendChild(overlay);

    const controller = new AbortController();
    cancel.addEventListener('click', () => controller.abort());

    try {
      status.textContent = `Enter code ${start.user_code} at ${start.verification_uri}`;
      await pollDeviceLogin(
        this.settings.codexProxyUrl,
        start,
        controller.signal
      );
      status.textContent = 'Signed in.';
    } finally {
      overlay.remove();
    }
  }

  private createEntryElement(entry: IAgentEntry): HTMLElement {
    const el = document.createElement('div');
    if (entry.kind === 'user') {
      el.className = 'jp-codex-agent-msg jp-codex-agent-msg-user';
    } else if (entry.kind === 'assistant-text') {
      el.className = 'jp-codex-agent-msg jp-codex-agent-msg-assistant';
    } else {
      el.className = 'jp-codex-agent-tool';
    }
    el.innerHTML = entry.html;
    return el;
  }

  private renderToolCard(
    name: string,
    input: Record<string, unknown>,
    result: unknown,
    status: 'running' | 'ok' | 'error'
  ): string {
    const icon =
      status === 'running' ? '⋯' : status === 'ok' ? '✓' : '✗';
    const argStr = Object.entries(input)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    const header = `<summary class="jp-codex-tool-header jp-codex-tool-${status}">` +
      `<span class="jp-codex-tool-icon">${icon}</span>` +
      `<code>${this.escapeHtml(name)}(${this.escapeHtml(argStr)})</code>` +
      `</summary>`;
    if (status === 'running') {
      return `<details class="jp-codex-tool-card" open>${header}</details>`;
    }
    const body = `<pre class="jp-codex-tool-body"><code>${this.escapeHtml(
      JSON.stringify(result, null, 2) ?? ''
    )}</code></pre>`;
    return `<details class="jp-codex-tool-card">${header}${body}</details>`;
  }

  private escapeHtml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
