import { useEffect, useRef, useState } from 'react';
import { useRealPort } from '../../data/react';
import { MenuPhoto } from '../../ui';
import type { ComponentProps } from 'react';

export function PosMenuPhoto({ photoFileId, ...fallback }: ComponentProps<typeof MenuPhoto> & { photoFileId?: string }) {
  const files = useRealPort()?.files;
  const target = useRef<HTMLSpanElement>(null);
  const [photo, setPhoto] = useState<{ id: string; url: string; files: typeof files }>();
  useEffect(() => {
    if (!photoFileId || !files || !target.current) return;
    let active = true;
    let url: string | undefined;
    const read = async () => {
      try {
        const next = await files.readUrl(photoFileId);
        if (!active) { URL.revokeObjectURL(next); return; }
        url = next;
        setPhoto({ id: photoFileId, url, files });
      } catch {
        // Show the menu artwork while the attachment is unavailable.
      }
    };
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer?.disconnect();
      void read();
    });
    if (observer) observer.observe(target.current);
    else void read();
    return () => {
      active = false;
      observer?.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [files, photoFileId]);
  if (!photoFileId || !files) return <MenuPhoto {...fallback}/>;
  return photo?.id === photoFileId && photo.files === files
    ? <span ref={target} className="ui-menu-photo" data-size="card" aria-hidden="true"><img src={photo.url} alt="" decoding="async"/></span>
    : <span ref={target}><MenuPhoto {...fallback}/></span>;
}
