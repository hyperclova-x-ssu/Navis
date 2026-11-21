export function prepareNaturalOverflow(): {
  region: string;
  scrollHeight: number;
  clientHeight: number;
} | null;

export function availableTabs(): Array<{ index: number; key: string; label: string }>;
