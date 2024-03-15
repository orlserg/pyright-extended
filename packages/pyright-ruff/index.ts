/* eslint @typescript-eslint/naming-convention: 0 */
import { Diagnostic, DiagnosticAction, DiagnosticCategory } from '../pyright-internal/src/common/diagnostic';
import { Range } from '../pyright-internal/src/common/textRange';
import { CodeAction, CodeActionKind, TextEdit, uinteger } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { Uri } from '../pyright-internal/src/common/uri/uri';

interface Location {
    column: number;
    row: number;
}

interface Edit {
    content: string;
    location: Location;
    end_location: Location;
}

interface Fix {
    applicability: 'Automatic' | 'Suggested' | 'Manual' | 'Unspecified';
    edits: Edit[];
    message: string;
}

interface RuffDiagnostic {
    code: string;
    location: Location;
    end_location: Location;
    filename: string;
    fix: Fix | null;
    message: string;
    noqa_row: number;
    url: string;
}

export interface RuffAction extends DiagnosticAction {
    action: string;
    source: 'ruff';
    code: string;
    payload: Fix;
}

// ruff uses 1-indexed columns and rows but LSP expects 0-indexed columns and rows
function convertRange(start: Location, end: Location): Range {
    return {
        start: {
            line: Math.max(start.row - 1, 0),
            character: Math.max(start.column - 1, 0),
        },
        end: {
            line: Math.max(end.row - 1, 0),
            character: Math.max(end.column - 1, 0),
        },
    };
}

function convertEdit(edit: Edit): TextEdit {
    return {
        newText: edit.content,
        range: convertRange(edit.location, edit.end_location),
    };
}

const UNUSED_CODES = ['F401']; // unused import
const ERROR_CODES = ['E999']; // syntax error
function convertDiagnostic(diag: RuffDiagnostic): Diagnostic {
    let category = DiagnosticCategory.Warning;
    if (ERROR_CODES.includes(diag.code)) {
        category = DiagnosticCategory.Error;
    } else if (UNUSED_CODES.includes(diag.code)) {
        category = DiagnosticCategory.UnusedCode;
    }
    const convertedDiag = new Diagnostic(category, diag.message, convertRange(diag.location, diag.end_location));

    if (diag.fix) {
        const action: RuffAction = {
            action: diag.fix.message,
            source: 'ruff',
            code: diag.code,
            payload: diag.fix,
        };
        convertedDiag.addAction(action);
    }

    convertedDiag.setRule(diag.code);
    return convertedDiag;
}

// see https://beta.ruff.rs/docs/rules/ for more info
function _runRuff(fp: Uri, buf: string, ...extraArgs: string[]): SpawnSyncReturns<Buffer> {
    const args = [
        'check',
        '--stdin-filename',
        fp.getPath(),
        '--quiet',
        '--output-format=json',
        '--force-exclude',
        ...(extraArgs ?? []),
        '-',
    ];
    return spawnSync(`ruff`, args, {
        input: buf,
    });
}

export function getRuffDiagnosticsFromBuffer(fileUri: Uri, buf: string): Diagnostic[] {
    const outBuf = _runRuff(fileUri, buf);
    if (outBuf.error || outBuf.stderr.length > 0) {
        console.error(`Error running ruff: ${outBuf.stderr}`);
        return [];
    }

    const stdout = outBuf.stdout.toString();
    const diags = JSON.parse(stdout) as RuffDiagnostic[];
    return diags.map(convertDiagnostic);
}

function ruffFix(fileUri: Uri, buf: string): string {
    const outBuf = _runRuff(fileUri, buf, '--fix-only');
    if (outBuf.error || outBuf.stderr.length > 0) {
        console.error(`Error running ruff: ${outBuf.stderr}`);
        return buf; // do nothing if we fail
    }

    const newBuf = outBuf.stdout.toString();
    return newBuf;
}

const ImportSortRegex = new RegExp(/^I\d{3}$/);
export function getCodeActions(fileUri: Uri, buf: string | null, diags: Diagnostic[]): CodeAction[] {
    const docUri = URI.file(fileUri.getPath()).toString();
    const constructChanges = (edits: TextEdit[]): Record<string, TextEdit[]> => {
        const changes: Record<string, TextEdit[]> = {};
        changes[docUri] = edits;
        return changes;
    };

    const actions = diags
        .filter((diag) => {
            const actions = (diag.getActions() ?? []) as RuffAction[];
            const ruffActions = actions.filter((a) => a.source === 'ruff');
            return ruffActions.length > 0;
        })
        .map((diag) => {
            const action = diag.getActions()![0] as RuffAction;
            const message = action.action;
            const fix = action.payload;
            const changes = constructChanges(fix.edits.map(convertEdit));
            const kind = action.code.match(ImportSortRegex)
                ? CodeActionKind.SourceOrganizeImports
                : CodeActionKind.QuickFix;
            return CodeAction.create(message, { changes }, kind);
        });

    // fix all code action, only added if we have track this file as opened (buf exists)
    if (buf) {
        const fixed = ruffFix(fileUri, buf);
        if (buf !== fixed) {
            const changes = constructChanges([
                {
                    // range may seem sus but this is what the official ruff lsp actually does https://github.com/astral-sh/ruff-lsp/blob/main/ruff_lsp/server.py#L735-L740
                    range: {
                        start: {
                            line: 0,
                            character: 0,
                        },
                        end: {
                            line: uinteger.MAX_VALUE,
                            character: 0,
                        },
                    },
                    newText: fixed,
                },
            ]);
            actions.push(
                CodeAction.create('Fix all automatically fixable errors', { changes }, CodeActionKind.SourceFixAll)
            );
        }
    }
    return actions;
}
