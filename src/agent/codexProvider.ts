// OpenAI Codex Responses API client.
//
// We keep the agent loop in an Anthropic-style Messages shape (it pairs
// well with the tool-result content blocks). This module is the translation
// layer:
//
//   IMessage[] + IToolSchema[]
//                 ↓  toResponsesRequest
//   POST {model, input, tools} → Codex proxy → /backend-api/codex/responses
//                 ↓  fromResponsesOutput
//             ICodexResponse
//
// The proxy forwards the user's Authorization header onto OpenAI and adds
// CORS headers on the way back. We never see or store the API key/token.

import {
  IAgentError,
  ICodexResponse,
  IContentBlock,
  IMessage
} from './client';
import { IToolSchema } from './tools';
import { getBearerToken, ICodexAuthState } from './codexAuth';
import { resolveProxyUrl } from './proxyUrl';

interface IResponsesInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
}
interface IResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}
interface IResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}
type IResponsesInputItem =
  | IResponsesInputMessage
  | IResponsesFunctionCall
  | IResponsesFunctionCallOutput;

interface IResponsesTool {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface IResponsesOutputMessage {
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string } | { type: string }>;
}
interface IResponsesOutput {
  output?: Array<IResponsesOutputMessage | IResponsesFunctionCall>;
  status?: string;
  error?: { message?: string } | string;
}

function toResponsesInput(messages: IMessage[]): IResponsesInputItem[] {
  const items: IResponsesInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      items.push({
        type: 'message',
        role: m.role,
        content: [{ type: 'input_text', text: m.content }]
      });
      continue;
    }
    for (const block of m.content) {
      if (block.type === 'text' && block.text) {
        items.push({
          type: 'message',
          role: m.role,
          content: [
            {
              type: m.role === 'assistant' ? 'output_text' : 'input_text',
              text: block.text
            }
          ]
        });
      } else if (block.type === 'tool_use') {
        items.push({
          type: 'function_call',
          call_id: block.id ?? '',
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {})
        });
      } else if (block.type === 'tool_result') {
        items.push({
          type: 'function_call_output',
          call_id: block.tool_use_id ?? '',
          output: block.content ?? ''
        });
      }
    }
  }
  return items;
}

function toResponsesTools(tools: IToolSchema[]): IResponsesTool[] {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.input_schema
  }));
}

function fromResponsesOutput(payload: IResponsesOutput): ICodexResponse {
  const blocks: IContentBlock[] = [];
  let sawToolCall = false;
  for (const item of payload.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content) {
        if (c.type === 'output_text' && 'text' in c) {
          blocks.push({ type: 'text', text: c.text });
        }
      }
    } else if (item.type === 'function_call') {
      sawToolCall = true;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        parsed = {};
      }
      blocks.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parsed
      });
    }
  }
  return {
    id: 'codex-response',
    role: 'assistant',
    content: blocks,
    stop_reason: sawToolCall ? 'tool_use' : 'end_turn'
  };
}

const SYSTEM_PROMPT =
  'You are an OpenAI Codex assistant embedded in JupyterLab. Use the ' +
  "provided kernel tools to inspect variables, read cells, and run snippets " +
  'before answering. Insert code into the notebook with `insert_cell` when ' +
  'the user asks you to write or try something. Keep replies concise and ' +
  'technical.';

export interface ICodexCallOptions {
  endpoint: string;
  model: string;
  auth: ICodexAuthState;
}

export async function callCodex(
  messages: IMessage[],
  tools: IToolSchema[],
  opts: ICodexCallOptions
): Promise<ICodexResponse | IAgentError> {
  const token = getBearerToken(opts.auth);
  if (!token) {
    return {
      error:
        'No Codex token found. Sign in with ChatGPT or import ~/.codex/auth.json.'
    };
  }
  // The ChatGPT-account Codex backend (chatgpt.com/backend-api/codex/responses)
  // requires `stream: true`; non-streamed requests return HTTP 400. We collect
  // SSE events into a final output[] list rather than rendering deltas live —
  // the agent loop only needs the completed response.
  const body = {
    model: opts.model,
    instructions: SYSTEM_PROMPT,
    input: toResponsesInput(messages),
    tools: toResponsesTools(tools),
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true
  };
  let response: Response;
  try {
    response = await fetch(resolveProxyUrl(opts.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return { error: `Network error reaching Codex proxy: ${(err as Error).message}` };
  }
  const text = await response.text();
  if (!response.ok) {
    let msg = `HTTP ${response.status}`;
    try {
      const errBody = JSON.parse(text) as {
        error?: string | { message?: string };
        detail?: string;
      };
      msg =
        errBody.detail ??
        (typeof errBody.error === 'string'
          ? errBody.error
          : errBody.error?.message ?? msg);
    } catch {
      if (text) msg = `${msg}: ${text.slice(0, 200)}`;
    }
    if (response.status === 401 || response.status === 403) {
      return {
        error: `${msg} — your Codex token may be expired. Re-run \`codex login\` and re-import.`
      };
    }
    return { error: msg };
  }
  return parseCodexSse(text);
}

function parseCodexSse(body: string): ICodexResponse | IAgentError {
  const items: Array<IResponsesOutputMessage | IResponsesFunctionCall> = [];
  let failedError: string | null = null;
  for (const block of body.split('\n\n')) {
    const dataLine = block
      .split('\n')
      .find(l => l.startsWith('data:'));
    if (!dataLine) continue;
    const json = dataLine.slice(5).trim();
    if (!json || json === '[DONE]') continue;
    let evt: {
      type?: string;
      item?: IResponsesOutputMessage | IResponsesFunctionCall;
      response?: { error?: { message?: string } | string };
    };
    try {
      evt = JSON.parse(json);
    } catch {
      continue;
    }
    if (evt.type === 'response.output_item.done' && evt.item) {
      items.push(evt.item);
    } else if (evt.type === 'response.failed') {
      const err = evt.response?.error;
      failedError =
        typeof err === 'string'
          ? err
          : err?.message ?? 'Codex stream reported response.failed';
    }
  }
  if (failedError) {
    return { error: failedError };
  }
  return fromResponsesOutput({ output: items });
}
