import { useLayoutEffect, useRef, useState } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { TaxPayment } from '../../../data/db/management-types';
import { useRealPort } from '../../../data/react';
import type { TaxEvidenceFile } from '../../../data/reality/18/dto';
import { resolveDataText } from '../../../data/widget-data';
import { ActionButton, DetailDialog } from '../../../ui';
import { useMoneyT } from './shared';
import { useRunTaxCommand } from './tax.commands';
import { useTaxCopy } from './tax.copy';
import { downloadTaxFile } from './tax.file';

const extensions: Readonly<Record<string, string>> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function TaxEvidence({ payment, host, onClose }: { payment: TaxPayment; host: WidgetHost; onClose: () => void }) {
  const t = useMoneyT();
  const copy = useTaxCopy();
  const port = useRealPort();
  const run = useRunTaxCommand(host, true);
  const [file, setFile] = useState<File>();
  const [removing, setRemoving] = useState<TaxEvidenceFile>();
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const files = payment.real?.evidenceFiles ?? [];
  const title = files.length ? copy('files') : t('widget.tax.addEvidence');
  const perform = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setFailed(false);
    try {
      await action();
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      pending.current = false;
      if (alive.current) setWorking(false);
    }
  };
  const attach = () => void perform(async () => {
    if (!file || !port || !payment.real) return;
    if (!extensions[file.type] || file.size === 0 || file.size > 4 * 1024 * 1024) throw new Error('Invalid evidence file');
    const storeId = await port.transport.storeId();
    if (!alive.current) return;
    const uploaded = await port.files.upload({ purpose: 'tax-evidence', blob: file });
    if (!alive.current || storeId !== await port.transport.storeId()) return;
    const result = await run({ type: 'tax.attachEvidence', taxPaymentId: payment.taxPaymentId, fileId: uploaded.fileId, expectedRevision: payment.real.revision });
    if (result.ok && alive.current) onClose();
  });
  const read = (entry: TaxEvidenceFile, filename: string) => void perform(async () => {
    if (!port) return;
    const url = await port.files.readUrl(entry.fileId);
    if (alive.current) downloadTaxFile(url, `${filename}.${extensions[entry.contentType] ?? 'bin'}`);
    else URL.revokeObjectURL(url);
  });
  const detach = () => void perform(async () => {
    if (!removing || !payment.real) return;
    const result = await run({ type: 'tax.detachEvidence', taxPaymentId: payment.taxPaymentId, fileId: removing.fileId, expectedRevision: payment.real.revision });
    if (result.ok && alive.current) setRemoving(undefined);
  });
  return <DetailDialog open title={removing ? copy('deleteFile') : title} dialogRole={removing ? 'alertdialog' : 'dialog'}
    onClose={() => { if (removing) setRemoving(undefined); else onClose(); }} description={resolveDataText(t, payment.type)}
    footer={removing
      ? <ActionButton variant="destructive" loading={working} onClick={detach}>{copy('detach')}</ActionButton>
      : files.length < 10 ? <ActionButton disabled={!file} loading={working} onClick={attach}>{copy('attach')}</ActionButton> : undefined}>
    {!removing ? <>
      {files.length ? <ul className="mm-plain-list">{files.map((entry, index) => <li key={entry.fileId}>
        <ActionButton variant="link" disabled={working} onClick={() => read(entry, `tax-evidence-${index + 1}`)}>{copy('fileNumber', { n: index + 1 })}</ActionButton>
        <ActionButton variant="ghost" disabled={working} aria-label={`${copy('fileNumber', { n: index + 1 })} · ${copy('detach')}`} onClick={() => setRemoving(entry)}>{copy('detach')}</ActionButton>
      </li>)}</ul> : null}
      {files.length < 10 ? <label className="mm-note">
        {copy('file')} <input type="file" name="tax-evidence" accept={Object.keys(extensions).join(',')} disabled={working}
          onChange={event => { setFailed(false); setFile(event.currentTarget.files?.[0]); }} />
      </label> : null}
    </> : null}
    {failed ? <p role="alert">{copy(file ? 'uploadError' : 'exportError')}</p> : null}
  </DetailDialog>;
}
