/**
 * Is a press outside the chat? The chat is its dock (pane and launcher). Two things outside the dock still belong to it: the notice toast, and any popup
 * a control inside the dock opened (`aria-controls` names the popup's id), which a portal renders elsewhere in the document.
 */
export function pressIsOutsideChat(dock: Element, target: EventTarget | null): boolean {
  if (!(target instanceof Node) || dock.contains(target)) return false;
  if (!(target instanceof Element)) return true;
  if (target.closest('.app-common-notice')) return false;
  const opened = new Set([...dock.querySelectorAll('[aria-controls]')].flatMap(control => control.getAttribute('aria-controls')?.split(/\s+/u) ?? []));
  for (let element: Element | null = target; element; element = element.parentElement) {
    if (element.id && opened.has(element.id)) return false;
  }
  return true;
}
