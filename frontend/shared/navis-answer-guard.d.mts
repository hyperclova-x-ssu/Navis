export function numbersIn(text: string): number[];
export function coversLines(text: string, lines: readonly string[]): boolean;
export function guardComposed(input: { readonly text: string; readonly lines: readonly string[]; readonly used?: readonly number[]; readonly question?: string; readonly context?: string }): string | null;
export function guardAnswer(input: { readonly text: string; readonly lines: readonly string[]; readonly used?: readonly number[]; readonly question?: string; readonly context?: string }): string | null;
