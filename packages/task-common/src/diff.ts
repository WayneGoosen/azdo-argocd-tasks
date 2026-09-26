// Unified diff rendering.
//
// Argo CD's managed-resources endpoint hands back targetState / liveState as STRINGS
// CONTAINING JSON, plus a `diff` field holding a JSON patch. The patch is precise but
// close to unreadable in a pipeline summary, so we render a real unified diff of the
// pretty-printed JSON instead.
//
// The LCS table is O(n*m), which is fine for manifests but not for something pathological,
// so oversized inputs degrade to a line-count summary rather than eating the agent's memory.

export const MAX_DIFF_LINES = 1500;

export interface RenderedDiff {
    /** Unified diff text, or a note explaining why it was not rendered. */
    text: string;
    truncated: boolean;
    addedLines: number;
    removedLines: number;
}

/** Longest common subsequence over lines, as a back-pointer table. */
function lcsLengths(before: readonly string[], after: readonly string[]): Int32Array {
    const rows = before.length + 1;
    const cols = after.length + 1;
    const table = new Int32Array(rows * cols);
    for (let i = before.length - 1; i >= 0; i -= 1) {
        for (let j = after.length - 1; j >= 0; j -= 1) {
            table[i * cols + j] =
                before[i] === after[j]
                    ? (table[(i + 1) * cols + (j + 1)] ?? 0) + 1
                    : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + (j + 1)] ?? 0);
        }
    }
    return table;
}

type DiffOp = { kind: ' ' | '-' | '+'; line: string };

export function diffLines(before: readonly string[], after: readonly string[]): DiffOp[] {
    const cols = after.length + 1;
    const table = lcsLengths(before, after);
    const ops: DiffOp[] = [];
    let i = 0;
    let j = 0;
    while (i < before.length && j < after.length) {
        if (before[i] === after[j]) {
            ops.push({ kind: ' ', line: before[i] as string });
            i += 1;
            j += 1;
        } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + (j + 1)] ?? 0)) {
            ops.push({ kind: '-', line: before[i] as string });
            i += 1;
        } else {
            ops.push({ kind: '+', line: after[j] as string });
            j += 1;
        }
    }
    while (i < before.length) {
        ops.push({ kind: '-', line: before[i] as string });
        i += 1;
    }
    while (j < after.length) {
        ops.push({ kind: '+', line: after[j] as string });
        j += 1;
    }
    return ops;
}

/** Collapse unchanged runs longer than 2*context into a marker line. */
export function renderUnified(
    before: readonly string[],
    after: readonly string[],
    context = 3,
): RenderedDiff {
    if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
        return {
            text: `Diff not rendered: resource is too large (${before.length} live lines, ${after.length} desired lines).`,
            truncated: true,
            addedLines: 0,
            removedLines: 0,
        };
    }

    const ops = diffLines(before, after);
    const keep = new Array<boolean>(ops.length).fill(false);
    ops.forEach((op, index) => {
        if (op.kind === ' ') {
            return;
        }
        for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) {
            keep[k] = true;
        }
    });

    const lines: string[] = [];
    let skipping = false;
    ops.forEach((op, index) => {
        if (keep[index] === true) {
            lines.push(`${op.kind}${op.line}`);
            skipping = false;
        } else if (!skipping) {
            lines.push('@@ ... @@');
            skipping = true;
        }
    });

    return {
        text: lines.join('\n'),
        truncated: false,
        addedLines: ops.filter((op) => op.kind === '+').length,
        removedLines: ops.filter((op) => op.kind === '-').length,
    };
}

/**
 * Pretty-print one of Argo CD's JSON-in-a-string state fields.
 * Returns an empty array when the field is absent (resource created or deleted).
 */
export function stateToLines(state: string | undefined): string[] {
    if (state === undefined || state.trim() === '') {
        return [];
    }
    try {
        return JSON.stringify(JSON.parse(state), null, 2).split('\n');
    } catch {
        // Not JSON after all -- show it as-is rather than hiding the resource.
        return state.split('\n');
    }
}
