/** F15 (REAL-PLAN B15): commands that exist only over HTTP. Existing `inquiry.*` and `notice.*` names and arguments stay unchanged. */
export type InboxRealCommand =
  /** The owner types an inquiry or review they received elsewhere. A manual record is answered by an owner attestation, not a provider call. */
  | { readonly type: 'inquiry.create'; readonly kind: 'review' | 'message'; readonly title: string; readonly body: string; readonly sourceUrl?: string; readonly idempotencyKey: string }
  /** Take one visible NAVER review (PN03) or TalkTalk consultation (PN06) into the reply queue. */
  | { readonly type: 'inquiry.import'; readonly source: 'review' | 'talktalk'; readonly providerRef: string; readonly idempotencyKey: string }
  /** One reply per review: change or remove it. Delete needs the extra confirmation. */
  | { readonly type: 'inquiry.editReply'; readonly threadId: string; readonly body: string; readonly idempotencyKey: string }
  | { readonly type: 'inquiry.deleteReply'; readonly threadId: string; readonly idempotencyKey: string }
  /**
   * The existing draft command, saving text that started from a NAVER (PN03) or Navis (PN14) draft preview. Same name and fields as
   * `inquiry.saveDraft`; `draftSource` only labels where the owner's edited text came from (B15 `draftSource`).
   */
  | { readonly type: 'inquiry.saveDraft'; readonly threadId: string; readonly body: string; readonly revision: number; readonly draftSource: 'naver-ai' | 'navis'; readonly idempotencyKey: string }
  /** Remove the NAVER Place news post published through a notice (extra confirmation). */
  | { readonly type: 'notice.deleteNews'; readonly noticeId: string; readonly idempotencyKey: string };
