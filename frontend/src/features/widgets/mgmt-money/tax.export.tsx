import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useDataExecute, useRealPort, useRealRetry } from '../../../data/react';
import type { TaxExportFile, TaxExportFormat, TaxExportPreviewDto, TaxExportReceipt } from '../../../data/reality/18/dto';
import { ActionButton, ChipChoice, DetailFooterContent, Icon } from '../../../ui';
import { useMoneyT } from './shared';
import { useTaxCopy } from './tax.copy';
import { downloadTaxFile, verifiedTaxFile } from './tax.file';
import type { ExampleTaxFormat } from './tax.example-file';

export function TaxExportActions({ read, disabled }: { read: TaxExportPreviewDto; disabled: boolean }) {
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
  return <ExportControls format={format} onFormat={value => { if (!pending.current) { setFormat(value); setStatus('idle'); } }}
    disabled={disabled || !port || read.verification.status !== 'verified'} working={status === 'working'} onExport={() => void getFile()}>
    {read.verification.status !== 'verified' ? <p className="mm-muted" role="status">{copy('unverified')}</p> : null}
    {status === 'done' ? <p className="mm-done" role="status"><Icon name="check" /> {copy('downloaded')}</p> : null}
    {status === 'error' || status === 'preview-changed' ? <p className="mm-muted" role="alert">{copy(status === 'error' ? 'exportError' : 'previewChanged')}</p> : null}
  </ExportControls>;
}

/** The one row of format choice and the accountant-file button, the same in both modes (PAR-1). */
function ExportControls({ format, onFormat, disabled, working, onExport, children }: {
  readonly format: TaxExportFormat; readonly onFormat: (format: TaxExportFormat) => void; readonly disabled: boolean; readonly working: boolean; readonly onExport: () => void; readonly children?: ReactNode;
}) {
  const t = useMoneyT();
  const copy = useTaxCopy();
  return <DetailFooterContent><div className="detail-footer-actions mm-actions">
    <ChipChoice label={copy('format')} value={format} onChange={onFormat} options={[{ value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }]} />
    <ActionButton variant="outline" disabled={disabled} loading={working} onClick={onExport}>{t('common.linked.tax.accountantFile')}</ActionButton>
    {children}
  </div></DetailFooterContent>;
}

/** With the example data the file is built in the browser from the rows shown above it; `build` throws when the export is refused. */
export function ExampleTaxExportActions({ build, disabled }: { readonly build: (format: ExampleTaxFormat) => { readonly blob: Blob; readonly filename: string }; readonly disabled: boolean }) {
  const copy = useTaxCopy();
  const [format, setFormat] = useState<ExampleTaxFormat>('csv');
  const [status, setStatus] = useState<'idle' | 'done' | 'error'>('idle');
  const exportFile = () => {
    try {
      const { blob, filename } = build(format);
      downloadTaxFile(URL.createObjectURL(blob), filename);
      setStatus('done');
    } catch {
      setStatus('error');
    }
  };
  return <ExportControls format={format} onFormat={value => { setFormat(value); setStatus('idle'); }} disabled={disabled} working={false} onExport={exportFile}>
    {status === 'done' ? <p className="mm-done" role="status"><Icon name="check" /> {copy('downloaded')}</p> : null}
    {status === 'error' ? <p className="mm-muted" role="alert">{copy('exportError')}</p> : null}
  </ExportControls>;
}
