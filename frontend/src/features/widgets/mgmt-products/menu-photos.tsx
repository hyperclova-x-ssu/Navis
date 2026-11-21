import { useId, useRef, useState, type ChangeEvent } from 'react';
import type { WidgetHost } from '../../../contracts';
import type { PosMenuPhotoDataUrl, PosMenuPhotoKey, PosMenuPhotoSelection } from '../../../contracts/pos';
import { useDataDispatch } from '../../../data/react';
import { dataBundles } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { ActionButton, Icon, MenuPhoto } from '../../../ui';
import { menuPhotoBundle, reportMenuResult } from './pos-menu-messages';
import './pos-menu.css';

const photoTypes = ['image/png', 'image/jpeg', 'image/webp'];
const maxPhotoBytes = 5 * 1024 * 1024;
const maxPhotoSide = 512;

async function resizePhoto(file: File): Promise<PosMenuPhotoDataUrl> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxPhotoSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/png');
    if (!url.startsWith('data:image/png;base64,')) throw new Error('Photo encoding failed');
    return url as PosMenuPhotoDataUrl;
  } finally {
    image.close();
  }
}

interface MenuPhotoEditorProps {
  menuId: string;
  name: string;
  photoKey: PosMenuPhotoKey | null;
  customPhotoUrl: PosMenuPhotoDataUrl | null;
  host: WidgetHost;
}

export function MenuPhotoEditor({ menuId, name, photoKey, customPhotoUrl, host }: MenuPhotoEditorProps) {
  const dispatch = useDataDispatch();
  const { t, locale } = useBundle(menuPhotoBundle, ...dataBundles);
  const errorId = useId();
  const uploadButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef<symbol | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const photoLabel = t('widget.menu.photo.label');
  const hasPhoto = Boolean(photoKey || customPhotoUrl);
  const uploadLabel = t(hasPhoto ? 'widget.menu.photo.replace' : 'widget.menu.photo.upload');
  const applyPhoto = (selection: PosMenuPhotoSelection) => {
    const command = { type: 'menu.setPhoto' as const, menuId, ...selection };
    const result = dispatch(command);
    reportMenuResult(host, result, command, name, t);
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    const file = field.files?.[0];
    field.value = '';
    if (!file || inFlight.current) return;
    if (!photoTypes.includes(file.type)) {
      setError('widget.menu.photo.wrongType');
      return;
    }
    if (file.size > maxPhotoBytes) {
      setError('widget.menu.photo.tooLarge');
      return;
    }

    setError(null);
    const request = Symbol();
    inFlight.current = request;
    setPending(true);
    const isCurrent = () => inFlight.current === request && input.current === field;
    try {
      const url = await resizePhoto(file);
      if (isCurrent()) applyPhoto({ photoKey: null, customPhotoUrl: url });
    } catch {
      if (isCurrent()) setError('widget.menu.photo.unreadable');
    } finally {
      if (isCurrent()) {
        inFlight.current = null;
        setPending(false);
      }
    }
  };
  const remove = () => {
    inFlight.current = null;
    setPending(false);
    setError(null);
    applyPhoto({ photoKey: null });
    uploadButton.current?.focus();
  };

  return <section className="menu-editor-section menu-photo-editor" aria-label={photoLabel} lang={locale}>
    <h4>{photoLabel}</h4>
    <MenuPhoto photoKey={photoKey} customPhotoUrl={customPhotoUrl} name={name} />
    {!hasPhoto && <span className="menu-photo-empty">{t('widget.menu.photo.none')}</span>}
    <div className="menu-pos-actions" aria-busy={pending || undefined}>
      <ActionButton ref={uploadButton} variant="secondary" aria-disabled={pending || undefined}
        aria-describedby={error ? errorId : undefined} onClick={() => { if (!inFlight.current) input.current?.click(); }}>
        {pending && <span className="ui-progress" aria-hidden="true" />}
        {uploadLabel}
      </ActionButton>
      <input ref={input} type="file" name="menu-photo" aria-label={uploadLabel} accept="image/*" hidden onChange={upload} />
      {hasPhoto && <ActionButton variant="ghost" onClick={remove}>{t('widget.menu.photo.remove')}</ActionButton>}
    </div>
    {error && <p className="ui-field__error" id={errorId} role="alert"><Icon name="error" />{t(error)}</p>}
  </section>;
}
