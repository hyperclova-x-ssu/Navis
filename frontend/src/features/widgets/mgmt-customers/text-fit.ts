/** Text geometry retains the fractional pixels lost by scrollWidth/clientWidth. */
export function textFitsBox(el: HTMLElement): boolean {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.5;
}
