import './menu-publication.css';
import { usePublicationText } from './menu-publication-text';
import { useEffect, useRef, useState } from 'react';
import type { PlaceMenuInput, PlaceMenuPreview, PlaceVenueInput, PlaceVenuePreview } from '../../../../../backend/services/inventory/reality/01/publication-dto';
import type { MenuItem, Venue } from '../../../../../backend/packages/naver/contracts/pn01/wire';
import type { PortFiles, PortTransport } from '../../../data/reality/00/port';
import { usePublication } from '../../../data/reality/01/use-publication';
import { useBundle, useI18n, type MessageBundle } from '../../../i18n';
import { ActionButton, Checkbox, DetailSidePanel, TextField } from '../../../ui';
import { PublicationCard, PublicationChanges, PublicationReadState } from './menu-publication-card';

const bundle: MessageBundle<string> = {
  id: 'gap-inv.place',
  ko: { publish: '플레이스에 올리기', venue: '업체 정보', name: '이름', price: '가격', address: '주소', phone: '전화', keywords: '대표 키워드(쉼표로 구분)', photos: '사진', photoAdd: '사진 올리기', photoRemove: '사진 지우기', rename: '바꿀 플레이스 메뉴', new: '같은 이름 메뉴를 자동으로 찾아요', saved: '저장했어요 · 검색에 반영되는 데 시간이 걸려요', conflict: '플레이스의 메뉴 이름을 확인해 주세요', open: '스마트플레이스 열기', noChanges: '플레이스와 같아서 올릴 것이 없어요', photoError: '사진을 올릴 수 없어요', rights: '이 사진을 업체 정보에 공개할 권리가 있어요' },
  en: { publish: 'Publish to Place', venue: 'Business information', name: 'Name', price: 'Price', address: 'Address', phone: 'Phone', keywords: 'Keywords (comma separated)', photos: 'Photos', photoAdd: 'Upload photo', photoRemove: 'Remove photo', rename: 'Place menu to update', new: 'Match the Navis menu name', saved: 'Saved. Search results may take time to update.', conflict: 'Check the menu name in Place.', open: 'Open SmartPlace', noChanges: 'Place already has these values.', photoError: 'Could not upload the photo', rights: 'I have the right to publish this photo in the business listing' },
  'zh-Hans': { publish: '发布到 Place', venue: '商家信息', name: '名称', price: '价格', address: '地址', phone: '电话', keywords: '关键词（用逗号分隔）', photos: '照片', photoAdd: '上传照片', photoRemove: '移除照片', rename: '要更新的 Place 菜单', new: '匹配 Navis 菜单名称', saved: '已保存，搜索结果更新需要时间。', conflict: '请检查 Place 菜单名称。', open: '打开 SmartPlace', noChanges: 'Place 中的信息相同。', photoError: '无法上传照片', rights: '我有权在商家信息中公开此照片' },
  'zh-Hant': { publish: '發布到 Place', venue: '商家資訊', name: '名稱', price: '價格', address: '地址', phone: '電話', keywords: '關鍵字（以逗號分隔）', photos: '照片', photoAdd: '上傳照片', photoRemove: '移除照片', rename: '要更新的 Place 選單', new: '比對 Navis 選單名稱', saved: '已儲存，搜尋結果更新需要時間。', conflict: '請檢查 Place 選單名稱。', open: '開啟 SmartPlace', noChanges: 'Place 中的資訊相同。', photoError: '無法上傳照片', rights: '我有權在商家資訊中公開此照片' },
};

export function MenuPlace({ transport, menuId }: { transport: PortTransport; menuId: string }) {
  const [opened, setOpened] = useState(false);
  const { t } = useBundle(bundle);
  return <section className="menu-editor-section">
    <ActionButton type="button" variant="secondary" aria-expanded={opened} onClick={() => setOpened(true)}>{t('publish')}</ActionButton>
    {opened && <MenuPlaceForm transport={transport} menuId={menuId} />}
  </section>;
}

function MenuPlaceForm({ transport, menuId }: { transport: PortTransport; menuId: string }) {
  const { t } = useBundle(bundle);
  const { format } = useI18n();
  const cardText = usePublicationText();
  const flow = usePublication<PlaceMenuInput, PlaceMenuPreview, { items: MenuItem[] }, { receiptId: string }>(
    transport, { path: '/inventory/menu/' + encodeURIComponent(menuId) + '/place', readPath: '/inventory/place/menu',
      operation: 'place.menu.publish', resourceId: menuId },
  );
  const [currentName, setCurrentName] = useState('');
  const view = flow.attempt?.diff;
  const desired = flow.confirmedPreview?.desired;
  const checked = desired && flow.data && !flow.readError && !flow.pending;
  const confirmed = checked && flow.data?.items.some(item => item.name === desired.name && item.price === desired.price);
  const display = (value: unknown) => typeof value === 'number' ? format.money(value, 'full') : String(value ?? '');

  return <>
    {!flow.data || flow.readError ? <PublicationReadState failed={!!flow.readError} retry={() => void flow.reload()} /> : null}
    {flow.readError && <a href="https://new.smartplace.naver.com/" target="_blank" rel="noreferrer">{t('open')}</a>}
    {flow.data && !flow.readError && !flow.attempt && <>
      <label className="ui-field">{t('rename')}
        <select className="ui-text-input" disabled={flow.pending} value={currentName} onChange={event => setCurrentName(event.target.value)}>
          <option value="">{t('new')}</option>
          {[...new Set(flow.data.items.map(item => item.name))].map(name => <option key={name}>{name}</option>)}
        </select>
      </label>
      <ActionButton type="button" variant="secondary" disabled={flow.pending} onClick={() => flow.preview(currentName ? { currentName } : {})}>{cardText('preview')}</ActionButton>
    </>}
    <PublicationCard flow={flow} label={t('publish')} errors={{ PLACE_MENU_NAME_CONFLICT: t('conflict'), PLACE_MENU_CHANGED: t('conflict'), NO_CHANGES: t('noChanges') }}>
      {view && <PublicationChanges changes={(Object.keys(view.patch) as (keyof MenuItem)[]).map(field =>
        ({ label: t(field), before: display(view.current?.[field]), after: display(view.patch[field]) }))} />}
    </PublicationCard>
    {checked && <p role={confirmed ? 'status' : 'alert'}>{confirmed ? t('saved') : cardText('uncertain')}</p>}
  </>;
}

export function VenuePlace({ transport, files, open, onOpenChange }: { transport: PortTransport; files?: PortFiles; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [localOpen, setLocalOpen] = useState(false);
  const opened = open ?? localOpen;
  const setOpened = onOpenChange ?? setLocalOpen;
  const trigger = useRef<HTMLButtonElement>(null);
  const { t } = useBundle(bundle);
  return <section className="menu-publication-venue" data-open={opened || undefined}>
    <ActionButton ref={trigger} type="button" variant="secondary" aria-expanded={opened} onClick={() => setOpened(!opened)}>{t('venue')}</ActionButton>
    <DetailSidePanel open={opened} selectedRowId="venue" title={t('venue')} onClose={() => setOpened(false)}
      returnFocusKey="venue" onRestoreFocus={() => trigger.current?.focus({ preventScroll: true })}>
      {opened && <div className="menu-publication-venue__body"><VenuePlaceForm transport={transport} files={files} /></div>}
    </DetailSidePanel>
  </section>;
}

const venuePath = '/inventory/place/venue';
function VenuePlaceForm({ transport, files }: { transport: PortTransport; files?: PortFiles }) {
  const { t } = useBundle(bundle);
  const cardText = usePublicationText();
  const flow = usePublication<PlaceVenueInput, PlaceVenuePreview, Venue, { receiptId: string }>(transport, { path: venuePath, operation: 'place.venue.publish', resourceId: 'venue' });
  const [draft, setDraft] = useState<PlaceVenueInput>({});
  const [keywords, setKeywords] = useState<string>();
  const [fileNames, setFileNames] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File>();
  const [rights, setRights] = useState(false);
  const [photoPending, setPhotoPending] = useState(false);
  const [photoError, setPhotoError] = useState(false);
  const busy = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const view = flow.attempt?.diff;
  const current = flow.data;
  const confirm = (requireExtra: boolean) => flow.confirm(requireExtra, () => {
    setDraft({});
    setKeywords(undefined);
  });
  if (!current || flow.readError) return <>
    <PublicationReadState failed={!!flow.readError} retry={() => void flow.reload()} />
    {flow.readError && <a href="https://new.smartplace.naver.com/" target="_blank" rel="noreferrer">{t('open')}</a>}
  </>;

  const photos = draft.photos ?? current.photos;
  const photoName = (ref: string, index: number) => fileNames[ref] ?? (ref === 'cafe-storefront' ? '매장 앞 사진' :
    ref.startsWith('cafe-interior-') ? `매장 안 사진 ${Number(ref.split('-').at(-1))}` : `${t('photos')} ${index + 1}`);
  const confirmedPatch = flow.confirmedPreview?.patch;
  const confirmed = confirmedPatch && (Object.keys(confirmedPatch) as (keyof Venue)[]).every(field =>
    JSON.stringify(confirmedPatch[field]) === JSON.stringify(current[field]));
  const fields = ['name', 'address', 'phone'] as const;
  const upload = async () => {
    if (!files || !file || !rights || busy.current) return;
    busy.current = true;
    setPhotoPending(true);
    setPhotoError(false);
    try {
      const { fileId } = await files.upload({ purpose: 'promo-photo', blob: file });
      setFileNames(previous => ({ ...previous, [fileId]: file.name }));
      setDraft(previous => ({ ...previous, photos: [...new Set([...(previous.photos ?? current.photos), fileId])] }));
      setFile(undefined);
      setRights(false);
      if (fileInput.current) fileInput.current.value = '';
    } catch {
      setPhotoError(true);
    } finally {
      busy.current = false;
      setPhotoPending(false);
    }
  };
  const disabled = flow.pending || photoPending;
  const preview = () => flow.preview({
    ...draft, ...(keywords === undefined ? {} : { keywords: keywords.split(',').map(value => value.trim()).filter(Boolean) }),
  });

  return <>
    {!flow.attempt && <>
      {fields.map(field => <TextField key={field} label={t(field)} disabled={disabled} value={draft[field] ?? current[field]}
        onValueChange={value => setDraft(previous => ({ ...previous, [field]: value }))} />)}
      <TextField label={t('keywords')} disabled={disabled} value={keywords ?? current.keywords.join(', ')} onValueChange={setKeywords} />
      <fieldset disabled={disabled}>
        <legend>{t('photos')}</legend>
        {photos.map((photo, index) => <p className="menu-venue-photo" key={photo}>
          <VenueThumbnail photo={photo} files={files} /><span>{photoName(photo, index)}</span>
          <ActionButton type="button" variant="ghost" onClick={() => setDraft(previous =>
            ({ ...previous, photos: photos.filter(ref => ref !== photo) }))}>{t('photoRemove')}</ActionButton>
        </p>)}
        {files && <>
          <input hidden aria-label={t('photoAdd')} ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp"
            onChange={event => { setFile(event.target.files?.[0]); setRights(false); setPhotoError(false); }} />
          <ActionButton type="button" variant="secondary" onClick={() => fileInput.current?.click()}>{file?.name ?? (t('photoAdd') === '사진 올리기' ? '사진 고르기' : t('photoAdd'))}</ActionButton>
          {file && <Checkbox checked={rights} onCheckedChange={setRights} label={t('rights')} />}
          <ActionButton type="button" variant="secondary" disabled={!file || !rights} loading={photoPending}
            onClick={() => { void upload(); }}>{t('photoAdd')}</ActionButton>
          {photoError && <p role="alert">{t('photoError')}</p>}
        </>}
      </fieldset>
      <ActionButton type="button" variant="secondary" disabled={disabled} onClick={preview}>{cardText('preview')}</ActionButton>
    </>}
    <PublicationCard key={flow.attempt?.previewId} flow={{ ...flow, confirm }} label={t('publish')} errors={{ NO_CHANGES: t('noChanges') }}
      requireExtra={view?.patch.photos !== undefined && view.current.photos.some(photo => !view.patch.photos?.includes(photo))}>
      {view && <PublicationChanges changes={(Object.keys(view.patch) as (keyof Venue)[]).map(field =>
        ({ label: t(field), before: field === 'photos' ? view.current.photos.map(photoName).join(', ') : String(view.current[field]),
          after: field === 'photos' ? view.patch.photos?.map(photoName).join(', ') ?? '' : String(view.patch[field]) }))} />}
    </PublicationCard>
    {confirmedPatch && !flow.pending && <p role={confirmed ? 'status' : 'alert'}>{confirmed ? t('saved') : cardText('uncertain')}</p>}
  </>;
}

function VenueThumbnail({ photo, files }: { photo: string; files?: PortFiles }) {
  const seeded = /^cafe-(?:storefront|interior-\d+)$/.test(photo);
  const [source, setSource] = useState<{ photo: string; url: string }>();
  useEffect(() => {
    if (!files || seeded) return;
    let active = true;
    let url: string | undefined;
    void files.readUrl(photo).then(value => {
      url = value;
      if (active) setSource({ photo, url });
      else URL.revokeObjectURL(url);
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [files, photo, seeded]);
  const url = seeded ? `/api/promo/photos/${encodeURIComponent(photo)}` : source?.photo === photo ? source.url : undefined;
  return url ? <img src={url} alt="" loading="lazy" /> : null;
}
