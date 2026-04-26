// Kernel-side tool runner. Thin wrapper around the generic `runPython`
// primitive — adds the tool-specific Python prelude (schemas + dispatcher
// in tools.ts) and the serialisation cap for tool_result content blocks.

import { Kernel } from '@jupyterlab/services';
import { runPython } from '../kernelRpc';
import { buildToolCode } from './tools';

export interface IToolResult {
  ok: boolean;
  value: unknown;
  stderr?: string;
}

export async function runTool(
  kernel: Kernel.IKernelConnection,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<IToolResult> {
  const code = buildToolCode(toolName, toolInput);
  const rpc = await runPython(kernel, code, 'CODEX_TOOL_RESULT');

  if (!rpc.ok) {
    return {
      ok: false,
      value: {
        error: 'tool did not produce a sentinel-wrapped result',
        stderr: rpc.stderr?.slice(-500),
        stdout: rpc.stdout?.slice(-500)
      },
      stderr: rpc.stderr
    };
  }

  return {
    ok: true,
    value: rpc.value,
    stderr: rpc.stderr
  };
}

/**
 * Compact a tool result for sending back to Codex as a tool_result content
 * block. Hard cap 4 KB so multi-turn tool-use doesn't balloon the request.
 */
export function serializeToolResult(result: IToolResult): string {
  const MAX = 4000;
  const s = JSON.stringify(result.value);
  if (s.length <= MAX) {
    return s;
  }
  return s.slice(0, MAX) + `\n... [truncated, original length ${s.length}]`;
}
