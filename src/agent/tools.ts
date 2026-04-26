// Kernel-side tool schemas + Python implementations for the Codex agent.
//
// The schemas are sent to the Codex Responses API via the `tools` parameter.
// The Python prelude is injected into the user's kernel on every tool call;
// re-defining the dispatcher is cheap and keeps tools fresh after restarts.

export interface IToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_SCHEMAS: IToolSchema[] = [
  {
    name: 'list_kernel_variables',
    description:
      "List non-private variables currently defined in the user's notebook " +
      'kernel, with their Python type and a short repr. Use this first when ' +
      "you don't know what's been defined.",
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'describe_dataframe',
    description:
      'Return a concise summary of a pandas DataFrame in the kernel: shape, ' +
      'column names, dtypes, null counts, and the first few rows. Use when ' +
      'the user asks about a dataset or you need to understand its schema.',
    input_schema: {
      type: 'object',
      properties: {
        var_name: {
          type: 'string',
          description: 'Name of the DataFrame variable in the kernel.'
        },
        sample_rows: {
          type: 'integer',
          description: 'Number of preview rows to include (default 5).',
          default: 5
        }
      },
      required: ['var_name']
    }
  },
  {
    name: 'run_python',
    description:
      "Execute a short Python snippet in the user's notebook kernel and " +
      'return its stdout, stderr, and the repr of the last expression. Use ' +
      'when you need to compute something, inspect a value, or test code ' +
      'before suggesting it. Do NOT use this to insert code into the ' +
      'notebook — use `insert_cell` for that.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python source to evaluate in the kernel.'
        }
      },
      required: ['code']
    }
  }
];

export const TOOL_PRELUDE = `
import json as __codex_json

def __codex_list_kernel_variables(**_):
    import builtins
    ns = globals()
    results = []
    skip = set(dir(builtins)) | {"In", "Out", "exit", "quit", "get_ipython"}
    for k, v in list(ns.items()):
        if k.startswith("_") or k in skip:
            continue
        if k.startswith("__codex_"):
            continue
        try:
            tname = type(v).__name__
            r = repr(v)
            if len(r) > 100:
                r = r[:100] + "..."
            results.append({"name": k, "type": tname, "repr": r})
        except Exception:
            results.append({"name": k, "type": "?", "repr": "<unrepr-able>"})
    return {"variables": results, "count": len(results)}

def __codex_describe_dataframe(var_name, sample_rows=5, **_):
    ns = globals()
    if var_name not in ns:
        return {"error": f"variable {var_name!r} not found in kernel"}
    df = ns[var_name]
    if not hasattr(df, "columns") or not hasattr(df, "shape"):
        return {"error": f"{var_name!r} is not a DataFrame (type: {type(df).__name__})"}
    try:
        cols = list(df.columns)
        dtypes = {c: str(df[c].dtype) for c in cols}
        nulls = {c: int(df[c].isna().sum()) for c in cols}
        head = df.head(int(sample_rows)).to_dict(orient="records")
        def _j(v):
            try:
                __codex_json.dumps(v)
                return v
            except Exception:
                return str(v)
        head = [{k: _j(v) for k, v in row.items()} for row in head]
        return {
            "shape": list(df.shape),
            "columns": cols,
            "dtypes": dtypes,
            "nulls": nulls,
            "head": head,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()[-500:]}

def __codex_run_python(code, **_):
    import io, contextlib, traceback as __tb
    ns = globals()
    out = io.StringIO()
    err = io.StringIO()
    last_value = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            # Evaluate as expression first; fall back to exec for statements.
            try:
                last_value = eval(code, ns)
            except SyntaxError:
                exec(code, ns)
        repr_val = None
        if last_value is not None:
            try:
                repr_val = repr(last_value)
                if len(repr_val) > 2000:
                    repr_val = repr_val[:2000] + "..."
            except Exception:
                repr_val = "<unrepr-able>"
        return {
            "stdout": out.getvalue()[-2000:],
            "stderr": err.getvalue()[-2000:],
            "value": repr_val,
        }
    except Exception as e:
        return {
            "error": str(e),
            "traceback": __tb.format_exc()[-1000:],
            "stdout": out.getvalue()[-2000:],
            "stderr": err.getvalue()[-2000:],
        }

__codex_tools = {
    "list_kernel_variables": __codex_list_kernel_variables,
    "describe_dataframe": __codex_describe_dataframe,
    "run_python": __codex_run_python,
}
`;

export function buildToolCode(
  name: string,
  input: Record<string, unknown>
): string {
  const inputJson = JSON.stringify(input);
  return `${TOOL_PRELUDE}
__codex_name = ${JSON.stringify(name)}
__codex_input = __codex_json.loads(${JSON.stringify(inputJson)})
try:
    __codex_result = __codex_tools[__codex_name](**__codex_input)
except KeyError:
    __codex_result = {"error": f"unknown tool: {__codex_name}"}
except Exception as __codex_e:
    import traceback as __codex_tb
    __codex_result = {"error": str(__codex_e), "traceback": __codex_tb.format_exc()[-500:]}
print("<<<CODEX_TOOL_RESULT>>>" + __codex_json.dumps(__codex_result) + "<<<END>>>")
`;
}
