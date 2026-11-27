/* 界面大小 is a CSS zoom on the app, so there are two pixels. getBoundingClientRect, a Range's rectangles and a pointer's clientX/Y are the
   pixels the screen draws; style.left, scrollTop, offsetWidth and clientWidth are the app's own. Whatever takes a number from the first and
   writes it to the second divides by this: how many drawn px one of the app's px is, measured on `element` (its drawn width over its layout
   width, so a zoom the host adds counts too). 1 where there is nothing to measure (before layout, a test's stand-in element).
   `box`: the element's rectangle, when the caller has already read it. */
export const drawnScale = (element, box) => {
  const own = element?.offsetWidth;
  if (!own) return 1;
  const drawn = (box || element.getBoundingClientRect?.())?.width;
  return drawn > 0 ? drawn / own : 1;
};
