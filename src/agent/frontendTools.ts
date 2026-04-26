// Frontend-side tools — operate on the notebook itself (inserting cells,
// reading cell sources/outputs). Called directly from the agent loop.

import { ICodeCellModel } from '@jupyterlab/cells';
import { INotebookTracker } from '@jupyterlab/notebook';
import { IToolSchema } from './tools';

export interface IFrontendToolContext {
  notebookTracker: INotebookTracker | null;
}

export const FRONTEND_TOOL_NAMES = new Set([
  'insert_cell',
  'get_cell_context',
  'get_selected_cell'
]);

export const FRONTEND_TOOL_SCHEMAS: IToolSchema[] = [
  {
    name: 'insert_cell',
    description:
      "Insert a new code cell into the user's active notebook, just below " +
      'the currently selected cell. Use this when the user asks you to ' +
      "*write*, *add*, or *try* some code — don't just suggest it as a " +
      'markdown snippet. Never overwrite existing cells.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The Python source code for the new cell.'
        },
        run: {
          type: 'boolean',
          description:
            'If true, execute the cell immediately after inserting it. ' +
            'Default false — let the user review first.',
          default: false
        }
      },
      required: ['source']
    }
  },
  {
    name: 'get_cell_context',
    description:
      'Read the source code and outputs of a specific code cell in the ' +
      "user's active notebook, identified by its execution count (the " +
      'number shown in the `[N]` gutter next to the cell). USE THIS FIRST ' +
      'whenever the user references a cell by number or position. For ' +
      'error outputs, the traceback is already ANSI-stripped and ready to ' +
      'reason about. Returns the source plus an `outputs` array in nbformat shape.',
    input_schema: {
      type: 'object',
      properties: {
        execution_count: {
          type: 'integer',
          description:
            'The execution count of the target cell, e.g. 17 for `[17]`.'
        }
      },
      required: ['execution_count']
    }
  },
  {
    name: 'get_selected_cell',
    description:
      "Read the source and outputs of the cell the user currently has " +
      'selected (focused) in the active notebook. USE THIS when the user ' +
      'says "this cell", "fix this", or refers to the current cell without ' +
      'naming a number.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  }
];

export async function runFrontendTool(
  name: string,
  input: Record<string, unknown>,
  ctx: IFrontendToolContext
): Promise<{ ok: boolean; value: unknown }> {
  if (name === 'insert_cell') {
    return insertCell(input, ctx);
  }
  if (name === 'get_cell_context') {
    return getCellContext(input, ctx);
  }
  if (name === 'get_selected_cell') {
    return getSelectedCell(ctx);
  }
  return { ok: false, value: { error: `unknown frontend tool: ${name}` } };
}

async function insertCell(
  input: Record<string, unknown>,
  ctx: IFrontendToolContext
): Promise<{ ok: boolean; value: unknown }> {
  const source = typeof input.source === 'string' ? input.source : '';
  const runAfter = input.run === true;

  const panel = ctx.notebookTracker?.currentWidget ?? null;
  if (!panel) {
    return {
      ok: false,
      value: { error: 'no active notebook — open a notebook first' }
    };
  }
  if (!source.trim()) {
    return { ok: false, value: { error: 'source is empty' } };
  }

  const notebook = panel.content;
  const activeIdx = notebook.activeCellIndex;
  const sharedModel = notebook.model?.sharedModel;
  if (!sharedModel) {
    return { ok: false, value: { error: 'notebook has no shared model' } };
  }

  const insertAt = activeIdx + 1;
  sharedModel.insertCell(insertAt, {
    cell_type: 'code',
    source,
    metadata: { trusted: true }
  });
  notebook.activeCellIndex = insertAt;

  if (runAfter) {
    try {
      await panel.context.sessionContext.ready;
      const sessionContext = panel.context.sessionContext;
      const kernel = sessionContext.session?.kernel;
      if (kernel) {
        const future = kernel.requestExecute({
          code: source,
          silent: false,
          store_history: true
        });
        await future.done;
      }
    } catch (err) {
      return {
        ok: true,
        value: {
          inserted_at: insertAt,
          ran: false,
          error: `run failed: ${(err as Error).message}`
        }
      };
    }
  }

  return {
    ok: true,
    value: {
      inserted_at: insertAt,
      ran: runAfter,
      lines: source.split('\n').length
    }
  };
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

function summarizeOutputs(model: ICodeCellModel): unknown[] {
  const raw = model.outputs.toJSON();
  return raw.map(o => {
    if (o.output_type === 'error') {
      const tb = Array.isArray(o.traceback)
        ? stripAnsi(o.traceback.join('\n'))
        : '';
      return {
        output_type: 'error',
        ename: o.ename,
        evalue: o.evalue,
        traceback: tb
      };
    }
    return o;
  });
}

async function getCellContext(
  input: Record<string, unknown>,
  ctx: IFrontendToolContext
): Promise<{ ok: boolean; value: unknown }> {
  const target = typeof input.execution_count === 'number'
    ? input.execution_count
    : Number(input.execution_count);
  if (!Number.isFinite(target)) {
    return { ok: false, value: { error: 'execution_count must be a number' } };
  }

  const panel = ctx.notebookTracker?.currentWidget ?? null;
  if (!panel) {
    return {
      ok: false,
      value: { error: 'no active notebook — open a notebook first' }
    };
  }

  for (const cell of panel.content.widgets) {
    if (cell.model.type !== 'code') continue;
    const m = cell.model as ICodeCellModel;
    if (m.executionCount !== target) continue;
    return {
      ok: true,
      value: {
        execution_count: target,
        source: m.sharedModel.getSource(),
        outputs: summarizeOutputs(m)
      }
    };
  }

  return {
    ok: false,
    value: { error: `no cell with execution_count=${target}` }
  };
}

async function getSelectedCell(
  ctx: IFrontendToolContext
): Promise<{ ok: boolean; value: unknown }> {
  const panel = ctx.notebookTracker?.currentWidget ?? null;
  if (!panel) {
    return {
      ok: false,
      value: { error: 'no active notebook — open a notebook first' }
    };
  }
  const active = panel.content.activeCell;
  if (!active) {
    return { ok: false, value: { error: 'no cell is selected' } };
  }
  if (active.model.type !== 'code') {
    return {
      ok: true,
      value: {
        cell_type: active.model.type,
        source: active.model.sharedModel.getSource(),
        outputs: []
      }
    };
  }
  const m = active.model as ICodeCellModel;
  return {
    ok: true,
    value: {
      cell_type: 'code',
      execution_count: m.executionCount,
      source: m.sharedModel.getSource(),
      outputs: summarizeOutputs(m)
    }
  };
}
