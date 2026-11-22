import { useLayoutEffect, useRef, useState } from 'react';
import { useDataExecute, useRealPort, useRealRetry } from '../../../data/react';
import type { TaxExportFile, TaxExportFormat, TaxExportPreviewDto, TaxExportReceipt } from '../../../data/reality/18/dto';
import { ActionButton, ChipChoice, Icon } from '../../../ui';
import { useMoneyT } from './shared';
import { useTaxCopy } from './tax.copy';
import { downloadTaxFile, verifiedTaxFile } from './tax.file';

export function TaxExportActions({ read, disabled }: { read: TaxExportPreviewDto; disabled: boolean }) {
  const t = useMoneyT();
  const copy = useTaxCopy();
  const execute = useDataExecute();
  const port = useRealPort();
  const retry = useRealRetry('tax');
  const [format, setFormat] = useState<TaxExportFormat>('csv');
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error' | 'preview-changed'>('idle');
  const pending = useRef(false);
  const alive = useRef(true);
  const frozen = useRef<TaxExportReceipt | null>(null);
  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const getFile = async () => {
    if (!port || pending.current || disabled || read.verification.status !== 'verified') return;
    pending.current = true;
    setStatus('working');
    try {
      const storeId = await port.transport.storeId();
      let receipt = frozen.current?.sourceRevision === read.sourceRevision ? frozen.current : null;
      if (!receipt) {
        const result = await execute({ type: 'tax.export', period: { start: read.from, end: read.to } });
        if (!alive.current) return;
        if (!result.ok) {
          if (result.reason === 'TAX_EXPORT_PREVIEW_CHANGED') {
            setStatus('preview-changed');
            retry();
            return;
          }
          throw new Error(result.messageKey);
        }
        receipt = (result.value as TaxExportReceipt | undefined) ?? null;
        if (!receipt?.resourceId || !receipt.files) throw new Error('Missing export receipt');
        if (receipt.sourceRevision !== read.sourceRevision) {
          setStatus('preview-changed');
          return;
        }
        frozen.current = receipt;
      }
      if (!alive.current || storeId !== await port.transport.storeId()) return;
      const file = await port.transport.request<TaxExportFile>({
        method: 'GET', path: `/pos/tax-exports/${encodeURIComponent(receipt.resourceId)}/file`, query: { format },
      });
      const expected = receipt.files[format];
      if (file.sha256 !== expected.sha256 || file.size !== expected.size || file.filename !== expected.filename || file.contentType !== expected.contentType) {
        throw new Error('Export receipt and file metadata differ');
      }
      const blob = await verifiedTaxFile(file, receipt.resourceId, format);
      if (!alive.current) return;
      downloadTaxFile(URL.createObjectURL(blob), file.filename);
      setStatus('done');
    } catch {
      if (alive.current) setStatus('error');
    } finally {
      pending.current = false;
    }
  };
  return <div className="mm-actions">
    <ChipChoice label={copy('format')} value={format} onChange={value => { if (!pending.current) { setFormat(value); setStatus('idle'); } }}
      options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }]} />
    <ActionButton size="primary" disabled={disabled || !port || read.verification.status !== 'verified'} loading={status === 'working'} onClick={() => void getFile()}>{t('common.linked.tax.accountantFile')}</ActionButton>
    {read.verification.status !== 'verified' ? <p className="mm-muted" role="status">{copy('unverified')}</p> : null}
    {status === 'done' ? <p className="mm-done" role="status"><Icon name="check" /> {copy('downloaded')}</p> : null}
    {status === 'error' || status === 'preview-changed' ? <p className="mm-muted" role="alert">{copy(status === 'error' ? 'exportError' : 'previewChanged')}</p> : null}
  </div>;
}
