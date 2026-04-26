// Persist agent transcripts to a file via JupyterLab's Contents API.
//
// File path: `.jupyterlab-codex-chat.json` at the JupyterLab root (the
// user's home in classic Lab, the virtual root in JupyterLite — an
// in-browser IndexedDB-backed filesystem that survives page reload).

import { Contents } from '@jupyterlab/services';
import { IMessage } from './client';

const TRANSCRIPT_PATH = '.jupyterlab-codex-chat.json';

export interface IAgentEntry {
  kind: 'user' | 'assistant-text' | 'tool';
  html: string;
}

export interface ITranscriptBundle {
  version: 1;
  entries: IAgentEntry[];
  messages: IMessage[];
  saved_at: string;
}

export class TranscriptStore {
  constructor(private contents: Contents.IManager) {}

  async load(): Promise<ITranscriptBundle | null> {
    try {
      const file: Contents.IModel = await this.contents.get(TRANSCRIPT_PATH, {
        content: true,
        type: 'file',
        format: 'text'
      });
      const raw =
        typeof file.content === 'string'
          ? file.content
          : JSON.stringify(file.content);
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        parsed.version === 1 &&
        Array.isArray(parsed.entries) &&
        Array.isArray(parsed.messages)
      ) {
        return parsed as ITranscriptBundle;
      }
      return null;
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === undefined) {
        return null;
      }
      console.warn('jupyterlab-codex: transcript load failed', err);
      return null;
    }
  }

  async save(
    entries: IAgentEntry[],
    messages: IMessage[]
  ): Promise<void> {
    const bundle: ITranscriptBundle = {
      version: 1,
      entries,
      messages,
      saved_at: new Date().toISOString()
    };
    try {
      await this.contents.save(TRANSCRIPT_PATH, {
        type: 'file',
        format: 'text',
        content: JSON.stringify(bundle, null, 2)
      });
    } catch (err) {
      console.warn('jupyterlab-codex: transcript save failed', err);
    }
  }

  async clear(): Promise<void> {
    try {
      await this.contents.delete(TRANSCRIPT_PATH);
    } catch {
      // Ignore — file may not exist.
    }
  }
}
