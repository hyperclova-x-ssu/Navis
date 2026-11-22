import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { useRealPort } from '../../../data/react';
import type { MenuPhotoContent } from '../../../data/reality/01/menu-dto';
import { MenuPhoto } from '../../../ui';

interface MenuPhotoImageProps extends ComponentProps<typeof MenuPhoto> {
  readonly photoFileId?: string | null;
  readonly photoContent?: MenuPhotoContent;
}

/** Shared by Menu and the order composer. Private images use the existing browser session and load on visibility. */
export function MenuPhotoImage({ photoFileId, photoContent, size = 'preview', ...fallback }: MenuPhotoImageProps) {
  const port = useRealPort();
  const target = useRef<HTMLSpanElement>(null);
  const path = photoContent?.path;
  const staticUrl = photoContent && !path ? photoContent.url : undefined;
  const key = photoContent?.url ?? photoFileId;
  const [photo, setPhoto] = useState<{ key: string; url: string; port: typeof port }>();

  useEffect(() => {
    if (!port || !key || staticUrl || !target.current) return;
    const controller = new AbortController();
    let url: string | undefined;
    const read = async () => {
      try {
        const next = path
          ? URL.createObjectURL(await port.transport.request<Blob>({ method: 'GET', path, responseAs: 'blob', signal: controller.signal }))
          : photoFileId ? await port.files.readUrl(photoFileId) : undefined;
        if (!next) return;
        if (controller.signal.aborted) {
          URL.revokeObjectURL(next);
          return;
        }
        url = next;
        setPhoto({ key, url, port });
      } catch {
        // Keep the existing artwork if the image cannot be read.
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
      controller.abort();
      observer?.disconnect();
      if (url) URL.revokeObjectURL(url);
    };
  }, [key, path, photoFileId, port, staticUrl]);

  const src = staticUrl ?? (photo?.key === key && photo?.port === port ? photo?.url : undefined);
  if (src) {
    const className = `ui-menu-photo${size === 'preview' || size === 'picker' ? ' menu-pos-photo' : ''}`;
    return <span ref={target} aria-hidden="true" className={className} data-size={size}>
      <img src={src} alt="" width={photoContent?.width} height={photoContent?.height} loading={staticUrl ? 'lazy' : undefined} decoding="async" />
    </span>;
  }
  const placeholder = <MenuPhoto {...fallback} size={size} />;
  return key && port ? <span ref={target}>{placeholder}</span> : placeholder;
}
