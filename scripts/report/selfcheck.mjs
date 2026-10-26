/* The finished deck page must not reach outside itself. This reads the page's markup (not its words): author text is escaped, so a
   sentence that mentions "@import" or "url(//x)" is only text and passes; a tag, attribute or style that would fetch something fails. */

const URL_ATTRIBUTES = new Set(["src", "href", "srcset", "action", "poster", "data", "formaction", "xlink:href", "background", "ping", "cite", "manifest"]);
const FORBIDDEN_TAGS = new Set(["link", "iframe", "frame", "object", "embed", "applet", "base", "form"]);
const TAG = /<([A-Za-z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const LOCAL = /^\s*(?:#|data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}\s*$)/i;

const stop = (what) => { throw new Error(`deck: the page would reach outside itself (${what})`); };

function checkCss(css, where) {
  if (/@import/i.test(css)) stop(`@import in ${where}`);
  for (const [, , address] of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)) if (!/^\s*(?:#|data:)/i.test(address)) stop(`url(${address.slice(0, 40)}) in ${where}`);
}

export function assertSelfContained(html) {
  let rest = html.replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, (match, attributes) => {
    if (/\ssrc\s*=/i.test(` ${attributes}`)) stop("a <script src>");
    return "<script></script>";
  });
  rest = rest.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (match, css) => { checkCss(css, "a <style>"); return "<style></style>"; });
  for (const [, name, attributes] of rest.matchAll(TAG)) {
    const tag = name.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) stop(`a <${tag}> tag`);
    for (const [, rawName, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
      const attribute = rawName.toLowerCase(), value = double ?? single ?? bare ?? "";
      if (attribute.startsWith("on")) stop(`the ${attribute} handler on <${tag}>`);
      if (attribute === "style") checkCss(value, `a style attribute on <${tag}>`);
      if (tag === "meta" && attribute === "http-equiv") stop("a <meta http-equiv>");
      if (URL_ATTRIBUTES.has(attribute) && !LOCAL.test(value)) stop(`${attribute}="${value.slice(0, 40)}" on <${tag}>`);
    }
  }
}
