// Codex Responses API client with tool-use loop.
//
// The loop is driven from the frontend: Codex emits tool_use blocks, we run
// them in the user's kernel via toolRunner (or in the browser via
// frontendTools), then send tool_result blocks back. Repeats until
// stop_reason === 'end_turn' (or a safety cap is hit).

import { Kernel } from '@jupyterlab/services';
import { INotebookTracker } from '@jupyterlab/notebook';
import { runTool, serializeToolResult } from './toolRunner';
import { TOOL_SCHEMAS } from './tools';
import {
  FRONTEND_TOOL_NAMES,
  FRONTEND_TOOL_SCHEMAS,
  runFrontendTool
} from './frontendTools';
import { callCodex } from './codexProvider';
import { ICodexAuthState } from './codexAuth';

const ALL_TOOL_SCHEMAS = [...TOOL_SCHEMAS, ...FRONTEND_TOOL_SCHEMAS];

const MAX_TOOL_ROUNDS = 6;

export interface IProviderConfig {
  endpoint: string;
  model: string;
  auth: ICodexAuthState;
}

/**
 * Sliding window for API history. We keep the first user turn (initial
 * question / context) plus the last `KEEP_LAST_TURNS` turns. The UI
 * transcript stays complete; only the request body sent to the proxy is
 * trimmed.
 */
const KEEP_LAST_TURNS = 6;

export function trimHistory(
  messages: IMessage[],
  keepLastTurns = KEEP_LAST_TURNS
): { messages: IMessage[]; trimmed: number } {
  const maxKept = keepLastTurns * 2 + 1;
  if (messages.length <= maxKept) {
    return { messages, trimmed: 0 };
  }
  const first = messages[0];
  const tail = messages.slice(-(keepLastTurns * 2));
  return {
    messages: [first, ...tail],
    trimmed: messages.length - (1 + tail.length)
  };
}

export interface IContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

export interface IMessage {
  role: 'user' | 'assistant';
  content: string | IContentBlock[];
}

export interface ICodexResponse {
  id: string;
  role: 'assistant';
  content: IContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
}

export interface IAgentError {
  error: unknown;
}

export interface IAgentEvents {
  onAssistantText?(text: string): void;
  onToolStart?(name: string, input: Record<string, unknown>): void;
  onToolResult?(
    name: string,
    input: Record<string, unknown>,
    result: unknown,
    ok: boolean
  ): void;
  onError?(message: string): void;
  /** Non-fatal notice (e.g. history trimming). Loop continues. */
  onWarning?(message: string): void;
  onDone?(): void;
}

async function callAgent(
  messages: IMessage[],
  provider: IProviderConfig,
  events: IAgentEvents
): Promise<ICodexResponse | IAgentError> {
  const { messages: toSend, trimmed } = trimHistory(messages);
  if (trimmed > 0) {
    events.onWarning?.(
      `Trimmed ${trimmed} older message(s) from the request to keep it ` +
        'within size limits. The agent may not remember earlier context.'
    );
  }
  return callCodex(toSend, ALL_TOOL_SCHEMAS, {
    endpoint: provider.endpoint,
    model: provider.model,
    auth: provider.auth
  });
}

/**
 * Run the tool-use loop. `messages` starts with at least one user message;
 * the caller keeps its own transcript for rendering. This function mutates
 * the `messages` array by appending assistant + user (tool_result) messages
 * as the loop progresses.
 */
export async function runAgentLoop(
  messages: IMessage[],
  kernel: Kernel.IKernelConnection | null,
  notebookTracker: INotebookTracker | null,
  provider: IProviderConfig,
  events: IAgentEvents = {}
): Promise<void> {
  let warnedThisTurn = false;
  const gatedEvents: IAgentEvents = {
    ...events,
    onWarning: msg => {
      if (!warnedThisTurn) {
        warnedThisTurn = true;
        events.onWarning?.(msg);
      }
    }
  };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callAgent(messages, provider, gatedEvents);
    if ('error' in response) {
      const msg =
        typeof response.error === 'string'
          ? response.error
          : JSON.stringify(response.error);
      events.onError?.(msg);
      events.onDone?.();
      return;
    }

    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'text' && block.text) {
        events.onAssistantText?.(block.text);
      }
    }

    if (response.stop_reason !== 'tool_use') {
      events.onDone?.();
      return;
    }

    const toolResults: IContentBlock[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const name = block.name ?? '';
      const input = block.input ?? {};
      const id = block.id ?? '';

      events.onToolStart?.(name, input);

      let result: { ok: boolean; value: unknown };
      if (FRONTEND_TOOL_NAMES.has(name)) {
        result = await runFrontendTool(name, input, { notebookTracker });
      } else if (!kernel) {
        result = {
          ok: false,
          value: {
            error: 'no active kernel — open a notebook first to use tools'
          }
        };
      } else {
        result = await runTool(kernel, name, input);
      }

      events.onToolResult?.(name, input, result.value, result.ok);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: serializeToolResult(result)
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  events.onError?.(`reached max tool rounds (${MAX_TOOL_ROUNDS})`);
  events.onDone?.();
}
