import { useId, useRef, useState } from 'react';
import type { PromoMenuModel, PromoVideoRowModel } from '../../../data/widget-data';
import { errorResult, toPortError, type CommandReceipt } from '../../../data/reality/00';
import { widgetFailureKey } from '../failure-line';
import { executePromo, type PromoRealCommand } from '../../../data/reality/16/commands';
import { safeAttestationLink, safePostLink, type PromoChannel } from '../../../data/reality/16/dto';
import { ActionButton, Checkbox, Icon, TextField } from '../../../ui';
import type { PromoSession } from './promo-session';
import { usePromoRealText } from './promo-real-copy';
import { text, useT } from './shared';

export function PromoPhotoUpload({ menus, session }: { readonly menus: readonly PromoMenuModel[]; readonly session: PromoSession }) {
  const t = usePromoRealText();
  const names = useT();
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [menuId, setMenuId] = useState('');
  const [rights, setRights] = useState(false);
  const [result, setResult] = useState<string>();
  const [pending, setPending] = useState(false);
  const pressing = useRef(false);
  const upload = async () => {
    const port = session.store.real;
    const storeId = session.store.getSnapshot().tables.realPromo?.storeId;
    if (!file || !rights || !port || !storeId || pressing.current) return;
    pressing.current = true;
    setPending(true);
    setResult(undefined);
    try {
      const uploaded = await port.files.upload({ purpose: 'promo-photo', blob: file });
      if (session.store.getSnapshot().tables.realPromo?.storeId !== storeId) return;
      const saved = await executePromo(session.store, { type: 'promo.addPhoto', fileId: uploaded.fileId, menuId: menuId || null,
        rightsConfirmed: true, idempotencyKey: `asset-${uploaded.fileId}` });
      if (!saved.ok) { setResult(widgetFailureKey(saved.messageKey)); return; }
      setResult('promo.real.photoSaved');
      setFile(undefined);
      setRights(false);
      if (fileInput.current) fileInput.current.value = '';
    } catch (error) { setResult(widgetFailureKey(errorResult(toPortError(error, 'POST')).messageKey)); }
    finally { pressing.current = false; setPending(false); }
  };
  return <section className="pv-real-fields" aria-label={t.t('promo.real.upload')}>
    <label htmlFor={`${id}-file`}>{t.t('promo.real.photoFile')}</label>
    <input id={`${id}-file`} ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={pending} onChange={event => {
      setFile(event.currentTarget.files?.[0]); setRights(false); setResult(undefined);
    }} />
    {menus.length ? <label htmlFor={`${id}-menu`}>{t.t('promo.real.photoMenu')}
      <select id={`${id}-menu`} className="ui-input" value={menuId} disabled={pending} onChange={event => setMenuId(event.currentTarget.value)}>
        <option value="">{t.t('promo.real.pickMenu')}</option>
        {menus.map(menu => <option key={menu.menuId} value={menu.menuId}>{text(names, menu.name)}</option>)}
      </select>
    </label> : null}
    <Checkbox checked={rights} disabled={pending} onCheckedChange={setRights} label={t.t('promo.real.rights')} />
    <ActionButton variant="secondary" aria-busy={pending || undefined} disabled={pending || !file || !rights || (menus.length > 0 && !menuId)} onClick={() => { void upload(); }}>{t.t('promo.real.upload')}</ActionButton>
    {result ? <p role="status" className="pv-caption">{result === 'promo.real.photoSaved' ? t.t(result) : names.t(result)}</p> : null}
  </section>;
}

const officialUploader = {
  clip: 'https://clipcreators.naver.com/',
  'place-news': 'https://new.smartplace.naver.com/',
};
const channels = ['clip', 'place-news'] as const;
const publicLink = (link: string | undefined) => {
  const checked = safePostLink(link);
  if (!checked) return undefined;
  const host = new URL(checked).hostname;
  return host === 'naver.com' || host.endsWith('.naver.com') ? checked : undefined;
};

export function PromoPlaceChoices<Place extends string>({ places, selected, label, placeLabel, onSelect, disabled }: {
  readonly places: readonly Place[]; readonly selected?: Place | null; readonly label: string;
  readonly placeLabel: (place: Place) => string; readonly onSelect: (place: Place) => void; readonly disabled?: boolean;
}) {
  const labelId = useId();
  return <>
    <p className="pv-label" id={labelId}>{label}</p>
    <div className="pv-places" role="radiogroup" aria-labelledby={labelId}>
      {places.map(place => <button key={place} type="button" role="radio" aria-checked={selected === place}
        className="pv-place-card" data-on={selected === place ? 'true' : 'false'} disabled={disabled} onClick={() => onSelect(place)}>
        {selected === place && <Icon name="check" aria-hidden />}<span>{placeLabel(place)}</span>
      </button>)}
    </div>
  </>;
}

export function PromoPublishActions({ video, session }: { readonly video: PromoVideoRowModel; readonly session: PromoSession }) {
  const t = usePromoRealText();
  const other = useT();
  const model = session.store.getSnapshot().tables.realPromo;
  const id = useId();
  const [channel, setChannel] = useState<PromoChannel>();
  const [manual, setManual] = useState(false);
  const [attesting, setAttesting] = useState(false);
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState('');
  const [tags, setTags] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'private'>('public');
  const [sponsored, setSponsored] = useState(false);
  const [commentsAllowed, setCommentsAllowed] = useState(true);
  const [link, setLink] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const pressed = useRef(false);
  const [prior, setPrior] = useState<Partial<Record<PromoChannel, PromoRealCommand>>>({});
  const select = (next: PromoChannel) => {
    const attempt = prior[next];
    setChannel(next); setManual(false); setAttesting(false); setLink(''); setMessage(undefined);
    setCaption(attempt?.type === 'promo.publishPlaceNews' ? attempt.text : attempt?.type === 'promo.publishClip' ? attempt.description : '');
    if (attempt?.type === 'promo.publishClip') {
      setCategory(attempt.category); setTags(attempt.hashtags.join(' ')); setVisibility(attempt.visibility);
      setSponsored(attempt.sponsored); setCommentsAllowed(attempt.commentsAllowed);
    }
  };
  const submit = async (command: PromoRealCommand) => {
    if (pressed.current) return;
    pressed.current = true;
    setPending(true);
    setMessage(undefined);
    try {
      const result = await executePromo(session.store, command);
      if (!result.ok) {
        if (result.reason === 'MANUAL_UPLOAD_REQUIRED') { setManual(true); return; }
        if (result.outcomeUnknown && channel && command.type !== 'promo.attestLink') setPrior(current => ({ ...current, [channel]: command }));
        setMessage(widgetFailureKey(result.messageKey));
        return;
      }
      if (command.type === 'promo.attestLink') { setAttesting(false); setManual(false); setMessage('promo.real.linkSaved'); }
      else if (channel) {
        setPrior(current => ({ ...current, [channel]: command }));
        const receipt = result.value as CommandReceipt;
        const status = session.store.getSnapshot().tables.realPromo?.publications.find(row => row.publicationId === receipt.resourceId)?.state;
        if (!status) setMessage('promo.real.publisherPending');
      }
    } finally { pressed.current = false; setPending(false); }
  };
  const publish = () => {
    if (!channel) return;
    const sameAttempt = prior[channel];
    if (sameAttempt) { void submit(sameAttempt); return; }
    const jobId = video.videoId;
    const idempotencyKey = `publish-${channel}-${jobId}`;
    void (channel === 'place-news'
      ? submit({ type: 'promo.publishPlaceNews', jobId, text: caption.trim(), idempotencyKey })
      : submit({ type: 'promo.publishClip', jobId, description: caption.trim(), category: category.trim(),
          hashtags: tags.split(/[ ,]+/u).map(tag => tag.replace(/^#/u, '')).filter(Boolean), visibility, sponsored, commentsAllowed, idempotencyKey }));
  };
  const attest = () => {
    if (!channel || !attesting) return;
    const checked = safeAttestationLink(link.trim(), channel);
    if (!checked) return;
    void submit({ type: 'promo.attestLink', jobId: video.videoId, route: channel, link: checked });
  };
  const history = model?.publications.filter(item => item.jobId === video.videoId) ?? [];
  const channelHistory = history.filter(item => item.channel === channel);
  const publisherDone = channelHistory.some(item => item.state === 'published');
  const alreadyHasLink = channelHistory.some(item => item.state === 'published' && item.link);
  const pendingRequest = channelHistory.some(item => item.state === 'pending');
  const canEdit = !pending && !(channel && prior[channel]);
  const uploader = channel ? publicLink(model?.uploadTargets?.[channel]) : undefined;
  return <div className="pv-place">
    <PromoPlaceChoices places={channels} selected={channel} label={other.t('promo.place.title')}
      placeLabel={value => t.t(`promo.real.${value}`)} disabled={pending} onSelect={select} />
    {history.map(item => {
      const href = safePostLink(item.link);
      return <p className="pv-caption" key={item.publicationId}>
        {item.channel === 'place-news' ? other.t('data.marketing.route.placeNews') : other.t(`promo.place.${item.channel}`)}
        {' · '}{t.t(item.state === 'published' ? 'promo.real.publisherDone' : item.state === 'failed' ? 'promo.real.error' : 'promo.real.publisherPending')}
        {href ? <> · <a href={href} target="_blank" rel="noopener noreferrer">{t.t('promo.real.postLink')}</a></> : null}
      </p>;
    })}
    {channel && !publisherDone && !manual ? <div className="pv-real-fields" key={channel}>
      <TextField label={t.t(channel === 'clip' ? 'promo.real.description' : 'promo.real.placeText')} value={caption} onValueChange={setCaption} disabled={!canEdit} />
      {channel === 'clip' ? <>
        <TextField label={t.t('promo.real.hashtags')} value={tags} onValueChange={setTags} disabled={!canEdit} />
        <TextField label={t.t('promo.real.category')} value={category} onValueChange={setCategory} disabled={!canEdit} />
        <label htmlFor={`${id}-visibility`}>{t.t('promo.real.visibility')}
          <select id={`${id}-visibility`} className="ui-input" value={visibility} disabled={!canEdit} onChange={event => setVisibility(event.currentTarget.value === 'private' ? 'private' : 'public')}>
            <option value="public">{t.t('promo.real.public')}</option><option value="private">{t.t('promo.real.private')}</option>
          </select>
        </label>
        <p className="pv-caption">{t.t('promo.real.aiUsed')}</p>
        <Checkbox checked={sponsored} disabled={!canEdit} onCheckedChange={setSponsored} label={t.t('promo.real.sponsored')} />
        <Checkbox checked={commentsAllowed} disabled={!canEdit} onCheckedChange={setCommentsAllowed} label={t.t('promo.real.comments')} />
      </> : null}
      <ActionButton disabled={pending || (!prior[channel] && (channel === 'place-news' ? !caption.trim() : !category.trim()))} aria-busy={pending || undefined} onClick={publish}>{pendingRequest ? other.t('common.retry') : t.t('promo.real.publish')}</ActionButton>
    </div> : null}
    {channel && !manual && !alreadyHasLink ? <ActionButton variant="secondary" disabled={pending} onClick={() => setManual(true)}>{t.t('promo.real.saveLink')}</ActionButton> : null}
    {channel && manual ? <div className="pv-real-fields">
      <p className="pv-caption">{t.t('promo.real.manual')}</p>
      <a href={uploader ?? officialUploader[channel]} target="_blank" rel="noopener noreferrer">{t.t('promo.real.uploader')}</a>
      <TextField label={t.t('promo.real.postLink')} value={link} disabled={pending} onValueChange={value => { setLink(value); setAttesting(false); }} />
      {attesting ? <div className="pv-real-fields">
        <p className="pv-caption">{t.t('promo.real.linkCheck')}</p>
        <ActionButton disabled={pending} aria-busy={pending || undefined} onClick={attest}>{t.t('promo.real.extra')}</ActionButton>
      </div> : <ActionButton disabled={pending || !safeAttestationLink(link.trim(), channel)} onClick={() => setAttesting(true)}>{t.t('promo.real.saveLink')}</ActionButton>}
    </div> : null}
    {message ? <p role="status" className="pv-caption">{message.startsWith('promo.real.') ? t.t(message) : other.t(message)}</p> : null}
  </div>;
}
