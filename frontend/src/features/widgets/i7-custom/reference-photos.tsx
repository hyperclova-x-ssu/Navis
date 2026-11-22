import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import type { PortFiles } from '../../../data/reality/00';
import { ActionButton } from '../../../ui';

/** HTTP builds keep a reference photo in the account service (purpose `custom-reference-photo`); the order holds only its file id. */
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 5;
const MAX_SIDE = 1024;

async function shrink(file: File): Promise<string> {
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    if (!url.startsWith('data:image/jpeg;base64,')) throw new Error('Photo encoding failed');
    return url;
  } finally {
    image.close();
  }
}

/** A photo just picked is a data URL (shown as it is); a stored one is read through the authorized file read. */
function usePhotoUrl(files: PortFiles, id: string) {
  const [state, setState] = useState<{ readonly id: string; readonly url?: string; readonly failed?: boolean }>({ id: '' });
  useEffect(() => {
    if (id.startsWith('data:')) return;
    let active = true;
    let made: string | undefined;
    void files.readUrl(id).then(url => {
      if (active) { made = url; setState({ id, url }); } else URL.revokeObjectURL(url);
    }, () => { if (active) setState({ id, failed: true }); });
    return () => { active = false; if (made) URL.revokeObjectURL(made); };
  }, [files, id]);
  if (id.startsWith('data:')) return { url: id, failed: false };
  return state.id === id ? { url: state.url, failed: !!state.failed } : { url: undefined, failed: false };
}

function Photo({ files, id, label, onRemove }: { readonly files: PortFiles; readonly id: string; readonly label: string; readonly onRemove?: () => void }) {
  const { url, failed } = usePhotoUrl(files, id);
  return <li className="custom-photo">
    {url ? <img src={url} alt={label} decoding="async" /> : <span className="custom-photo-empty" role={failed ? 'alert' : 'status'}>{failed ? '사진을 불러오지 못했어요' : '사진을 불러오고 있어요'}</span>}
    {onRemove && <ActionButton variant="ghost" aria-label={`${label} 빼기`} onClick={onRemove}>빼기</ActionButton>}
  </li>;
}

/** The order's reference photos, read-only. */
export function ReferencePhotos({ files, ids }: { readonly files: PortFiles; readonly ids: readonly string[] }) {
  return <section aria-label="참고 사진" className="custom-photos"><h4>참고 사진</h4>
    <ul>{ids.map((id, index) => <Photo key={id} files={files} id={id} label={`참고 사진 ${index + 1}`} />)}</ul></section>;
}

/** Pick, shrink and list the photos of an order form. New photos stay data URLs until the order is saved; the command stores them once. */
export function ReferencePhotoPicker({ files, values, onChange }: { readonly files: PortFiles; readonly values: readonly string[]; readonly onChange: (values: readonly string[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const add = async (event: ChangeEvent<HTMLInputElement>) => {
    const field = event.currentTarget;
    const picked = [...(field.files ?? [])];
    field.value = '';
    if (!picked.length || pending) return;
    if (values.length + picked.length > MAX_PHOTOS) { setError(`사진은 ${MAX_PHOTOS}장까지 넣을 수 있어요`); return; }
    if (picked.some(file => !TYPES.includes(file.type))) { setError('PNG, JPEG, WebP 사진만 넣을 수 있어요'); return; }
    if (picked.some(file => file.size > MAX_BYTES)) { setError('사진은 한 장에 5MB 이하여야 해요'); return; }
    setError('');
    setPending(true);
    try {
      const urls = await Promise.all(picked.map(shrink));
      if (alive.current) onChange([...values, ...urls.filter(url => !values.includes(url))]);
    } catch {
      if (alive.current) setError('사진을 읽지 못했어요. 다른 사진으로 해 주세요');
    } finally {
      if (alive.current) setPending(false);
    }
  };
  return <div className="custom-photo-picker" aria-busy={pending || undefined}>
    {values.length > 0 && <ul className="custom-photos">{values.map((value, index) => <Photo key={value} files={files} id={value} label={`참고 사진 ${index + 1}`}
      onRemove={() => onChange(values.filter(item => item !== value))} />)}</ul>}
    <ActionButton variant="secondary" disabled={values.length >= MAX_PHOTOS} aria-describedby={error ? errorId : undefined} onClick={() => { if (!pending) input.current?.click(); }}>
      {pending && <span className="ui-progress" aria-hidden="true" />}참고 사진 올리기
    </ActionButton>
    <input ref={input} type="file" name="custom-reference-photo" aria-label="참고 사진 올리기" accept={TYPES.join(',')} multiple hidden onChange={event => void add(event)} />
    {error && <p className="custom-error" id={errorId} role="alert">{error}</p>}
  </div>;
}
