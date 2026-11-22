export type LocalRealCommand =
  | { readonly type: 'localChanges.create'; readonly title: string; readonly region: string; readonly referenceDate: string; readonly sourceUrl?: string }
  | { readonly type: 'community.create'; readonly recipientStoreId: string; readonly title: string; readonly terms: string;
      readonly startsOn: string; readonly endsOn: string; readonly respondBy: string };
