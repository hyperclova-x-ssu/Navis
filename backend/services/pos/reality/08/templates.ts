import { randomUUID } from 'node:crypto';
import type { CustomTemplateField } from '../../../../../frontend/src/data/iteration7/custom-orders/types.ts';
import { applyCommand } from '../../ledger.ts';
import { integer, object, PosError, type PosTx } from '../../wire.ts';
import { confirm, fields, stale, text } from './input.ts';
import { putTemplate, templateDetail } from './records.ts';
import { registerUndo, type UndoEffect } from './undo.ts';

const exampleFields: CustomTemplateField[] = [
  { fieldId: 'message', label: '요청 문구', input: 'text', required: true, options: [] },
  { fieldId: 'size', label: '크기', input: 'single', required: true, options: [
    { optionId: 'one', label: '기본', extraAmount: 0 }, { optionId: 'large', label: '크게', extraAmount: 5000 },
  ] },
  { fieldId: 'extras', label: '추가 옵션', input: 'multiple', required: false, options: [
    { optionId: 'candle', label: '초 추가', extraAmount: 1000 }, { optionId: 'ribbon', label: '리본 포장', extraAmount: 0 },
  ] },
  { fieldId: 'eventAt', label: '행사 일시', input: 'datetime', required: false, options: [] },
];

export function saveTemplate(tx: PosTx, key: string, body: unknown, id?: string) {
  const input = object(body, id ? ['name', 'fields', 'expectedRevision'] : ['name', 'fields']);
  const content = { name: text(input.name, 'name', 120), fields: fields(input.fields) };
  const expectedRevision = id ? integer(input.expectedRevision, 1) : 0;
  return applyCommand(tx, 'customTemplate.save', key, { id, expectedRevision, ...content }, async () => {
    const previous = id ? await templateDetail(tx, id) : null;
    if (previous) stale(expectedRevision, previous.revision);
    const row = { ...content, templateId: id ?? randomUUID(), revision: expectedRevision + 1, archivedAt: null };
    return registerUndo(tx, await putTemplate(tx, row), 'customTemplate.save', key,
      { kind: 'template', templateId: row.templateId, revision: row.revision, previous });
  });
}

export function generateTemplate(tx: PosTx, key: string, body: unknown) {
  const input = object(body, ['productKind', 'keywords']);
  const productKind = text(input.productKind, 'productKind', 50);
  const keywords = text(input.keywords, 'keywords', 60, true);
  const name = `${productKind} 주문서${keywords ? ' · ' + keywords : ''}`;
  return applyCommand(tx, 'customTemplate.generate', key, { productKind, keywords }, async () => {
    const row = { templateId: randomUUID(), name, fields: exampleFields, revision: 1, archivedAt: null };
    return registerUndo(tx, await putTemplate(tx, row), 'customTemplate.generate', key,
      { kind: 'template', templateId: row.templateId, revision: row.revision, previous: null });
  });
}

export function archiveTemplate(tx: PosTx, key: string, id: string, body: unknown) {
  const input = object(body, ['expectedRevision', 'confirmed']);
  confirm(input.confirmed);
  const expectedRevision = integer(input.expectedRevision, 1);
  return applyCommand(tx, 'customTemplate.delete', key, { id, expectedRevision }, async () => {
    const previous = await templateDetail(tx, id);
    stale(expectedRevision, previous.revision);
    const row = { ...previous, archivedAt: tx.at.toISOString(), revision: previous.revision + 1 };
    return registerUndo(tx, await putTemplate(tx, row), 'customTemplate.delete', key,
      { kind: 'template', templateId: id, revision: row.revision, previous });
  });
}

export async function undoTemplate(tx: PosTx, effect: Extract<UndoEffect, { kind: 'template' }>) {
  const current = await templateDetail(tx, effect.templateId, true);
  if (current.revision !== effect.revision) throw new PosError(409, 'UNDO_UNAVAILABLE');
  if (!effect.previous) {
    const anyOrder = await tx.db.query('SELECT 1 FROM pos.custom_order WHERE store_id=$1 AND template_id=$2 LIMIT 1',
      [tx.storeId, current.templateId]);
    if (anyOrder.rowCount) throw new PosError(409, 'UNDO_UNAVAILABLE');
  }
  return putTemplate(tx, { ...(effect.previous ?? { ...current, archivedAt: tx.at.toISOString() }), revision: current.revision + 1 });
}
