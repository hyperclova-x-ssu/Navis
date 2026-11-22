interface RealCommandMetadata {
  readonly domain: string;
  readonly command: string;
  readonly workflow?: true;
}

export const realCommandRegistry: Readonly<Record<string, RealCommandMetadata>>;
export function realCommandFor(policyName: string, args?: unknown): RealCommandMetadata | undefined;
