import { useEffect, useState } from 'react';
import type { PortFiles } from '../../../data/reality/00/port';
import { defineBundle, useBundle } from '../../../i18n';

const copy = defineBundle({
  id: 'manual-step-photo',
  ko: { photo: '{step}단계 사진', download: '{step}단계 사진 받기', loading: '단계 사진을 불러오고 있어요', failed: '단계 사진을 불러오지 못했어요' },
  en: { photo: 'Step {step} photo', download: 'Download step {step} photo', loading: 'Loading step photo', failed: 'Could not load the step photo' },
  'zh-Hans': { photo: '第 {step} 步照片', download: '下载第 {step} 步照片', loading: '正在加载步骤照片', failed: '无法加载步骤照片' },
  'zh-Hant': { photo: '第 {step} 步照片', download: '下載第 {step} 步照片', loading: '正在載入步驟照片', failed: '無法載入步驟照片' },
});

export function ManualStepPhoto({ files, fileId, stepNo }: { readonly files: PortFiles; readonly fileId: string; readonly stepNo: number }) {
  const { t } = useBundle(copy);
  const [loaded, setLoaded] = useState<{ readonly files: PortFiles; readonly url?: string }>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void files.readUrl(fileId).then(next => {
      if (!active) { URL.revokeObjectURL(next); return; }
      url = next;
      setLoaded({ files, url });
    }, () => { if (active) setLoaded({ files }); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [files, fileId]);

  if (loaded?.files !== files) return <p className="mgmt-note" role="status">{t('loading')}</p>;
  if (!loaded.url) return <p className="mgmt-note" role="alert">{t('failed')}</p>;
  return <div className="mgmt-photos">
    <img className="mgmt-photo" src={loaded.url} alt={t('photo', { step: stepNo })} decoding="async" />
    <a className="ui-button ui-button--link ui-button--default" href={loaded.url} download><span className="ui-press-surface">{t('download', { step: stepNo })}</span></a>
  </div>;
}
