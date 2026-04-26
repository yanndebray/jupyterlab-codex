// Generic "run Python in the user's kernel, parse a sentinel-wrapped JSON
// result from IOPub" primitive. Used by the agent's tool runner.
//
// Pattern: the Python code you submit is expected to print, somewhere in
// stdout, a line of the form `<<<SENTINEL>>>{json}<<<END>>>`. Everything
// between the sentinels is parsed; stderr is preserved for debugging.

import { Kernel, KernelMessage } from '@jupyterlab/services';

export const SENTINEL_CLOSE = '<<<END>>>';

export interface IRpcResult<T = unknown> {
  ok: boolean;
  value: T | null;
  stderr?: string;
  stdout?: string;
}

export async function runPython<T = unknown>(
  kernel: Kernel.IKernelConnection,
  code: string,
  sentinel: string
): Promise<IRpcResult<T>> {
  const openTag = `<<<${sentinel}>>>`;
  const future = kernel.requestExecute({
    code,
    silent: true,
    stop_on_error: false,
    store_history: false
  });

  let stdout = '';
  let stderr = '';

  future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
    const msgType = msg.header.msg_type;
    if (msgType === 'stream') {
      const content = msg.content as KernelMessage.IStreamMsg['content'];
      if (content.name === 'stdout') {
        stdout += content.text;
      } else if (content.name === 'stderr') {
        stderr += content.text;
      }
    } else if (msgType === 'error') {
      const content = msg.content as KernelMessage.IErrorMsg['content'];
      stderr +=
        `${content.ename}: ${content.evalue}\n` +
        (content.traceback ?? []).join('\n');
    }
  };

  await future.done;

  const start = stdout.indexOf(openTag);
  const end = stdout.indexOf(SENTINEL_CLOSE, start);
  if (start === -1 || end === -1) {
    return {
      ok: false,
      value: null,
      stderr,
      stdout: stdout.slice(-500)
    };
  }

  const jsonStr = stdout.slice(start + openTag.length, end);
  try {
    return {
      ok: true,
      value: JSON.parse(jsonStr) as T,
      stderr: stderr || undefined,
      stdout
    };
  } catch (err) {
    return {
      ok: false,
      value: null,
      stderr:
        (stderr || '') +
        `\nfailed to parse JSON: ${(err as Error).message}\n` +
        `raw: ${jsonStr.slice(0, 300)}`
    };
  }
}
