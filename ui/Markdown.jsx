import React from "react";

/**
 * Safe Markdown for study text: builds React elements only (no HTML is ever
 * parsed or injected), so source and model text cannot execute markup.
 * Single newlines are line breaks, matching chat-style model output.
 */
const COLOR_OPEN = "c",
  COLOR_MID = "",
  COLOR_CLOSE = "/c";
const INLINE = [
  ["code", /`([^`\n]+)`/],
  ["color", /c(#[0-9a-fA-F]{3,8})([\s\S]*?)\/c/],
  ["strong", /\*\*(?=\S)([\s\S]*?\S)\*\*/],
  ["strong", /__(?=\S)([\s\S]*?\S)__/],
  ["del", /~~(?=\S)([\s\S]*?\S)~~/],
  ["em", /(?<![*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/],
  ["link", /\[([^\]\n]+)\]\(([^)\s]+)\)/],
  ["url", /\bhttps?:\/\/[^\s<>()（）]+[^\s<>()（）.,;:!?，。；：！？]/],
];
const safeHref = (href) => (/^(https?:|mailto:)/i.test(href) ? href : null);
const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const STRIP = /<\/?(?:span|font|u|mark|small|big|center|sup|sub|a|abbr|ins|div|p)(?:\s[^<>]*)?>/gi;
const COLORED_SPAN =
  /<span\s[^<>]*?style\s*=\s*["'][^"']*?color\s*:\s*(#[0-9a-fA-F]{3,8})\b[^"']*["'][^<>]*>([^<]*?)<\/span>/gi;
const DETAILS_OPEN = /^\s*<details\b[^<>]*>\s*$/i,
  DETAILS_CLOSE = /^\s*<\/details>\s*$/i,
  SUMMARY = /^\s*<summary[^<>]*>(.*?)<\/summary>\s*$/i;

/**
 * Notes often carry light HTML (colored spans, <b>, <br>, <details>). Map an
 * allowlist onto Markdown; every other tag stays visible as plain text. Only a
 * validated hex color survives, applied later as a React style value.
 */
function tidyHtml(line) {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/[-]/g, "")
            .replace(/<br\s*\/?>/gi, "")
            .replace(COLORED_SPAN, (_, color, body) => COLOR_OPEN + color + COLOR_MID + body + COLOR_CLOSE)
            .replace(/<(b|strong)(?:\s[^<>]*)?>([^<]*?)<\/\1>/gi, "**$2**")
            .replace(/<(i|em)(?:\s[^<>]*)?>([^<]*?)<\/\1>/gi, "*$2*")
            .replace(/<code>([^<`]*)<\/code>/gi, "`$1`")
            .replace(STRIP, "")
            .replace(/&(nbsp|amp|lt|gt|quot|apos|#39);/g, (_, name) => ENTITIES[name]),
    )
    .join("");
}

function inline(text, links, key = "i") {
  const out = [];
  let rest = text.replace(//g, " "),
    n = 0;
  while (rest) {
    let best = null;
    for (const [type, re] of INLINE) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { type, m };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    const { type, m } = best,
      k = `${key}.${n++}`;
    if (m.index) out.push(rest.slice(0, m.index));
    if (type === "code") out.push(<code key={k}>{m[1]}</code>);
    else if (type === "color")
      out.push(
        <span key={k} className="md-color" style={{ color: m[1] }}>
          {inline(m[2], links, k)}
        </span>,
      );
    else if (type === "strong" || type === "em" || type === "del")
      out.push(React.createElement(type, { key: k }, inline(m[1], links, k)));
    else {
      const label = type === "link" ? inline(m[1], links, k) : m[0],
        href = safeHref(type === "link" ? m[2] : m[0]);
      out.push(
        links && href ? (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>
        ) : (
          <span key={k} className="md-link">
            {label}
          </span>
        ),
      );
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
function lines(text, links, key) {
  // Newlines and <br> (marked ) are both line breaks inside a block.
  return text
    .split(/[\n]/)
    .flatMap((line, i) =>
      i
        ? [<br key={`${key}.br${i}`} />, ...inline(line, links, `${key}.${i}`)]
        : inline(line, links, `${key}.${i}`),
    );
}

const LIST = /^(\s*)([-*+•]|\d{1,3}[.)、])\s+(.*)$/;
const cells = (row) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Normalize line endings and convert allowed HTML outside code fences. */
function prepare(src) {
  let fenced = false;
  return src
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((row) => {
      if (/^\s*(```|~~~)/.test(row)) {
        fenced = !fenced;
        return [row];
      }
      return [fenced ? row : tidyHtml(row)];
    });
}

function blocks(rows, links) {
  const out = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i],
      key = "b" + out.length;
    if (!row.trim()) {
      i++;
      continue;
    }
    const fence = row.match(/^\s*(```|~~~)/);
    if (fence) {
      const body = [];
      for (i++; i < rows.length && !rows[i].trim().startsWith(fence[1]); i++)
        body.push(rows[i]);
      i++;
      out.push(
        <pre key={key} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (DETAILS_OPEN.test(row)) {
      const body = [];
      let depth = 1,
        summary = "";
      for (i++; i < rows.length; i++) {
        if (DETAILS_OPEN.test(rows[i])) depth++;
        if (DETAILS_CLOSE.test(rows[i]) && !--depth) break;
        const s = depth === 1 && !summary && rows[i].match(SUMMARY);
        if (s) summary = s[1];
        else body.push(rows[i]);
      }
      i++;
      out.push(
        <details key={key} className="md-details">
          <summary>{inline(summary || "详情", links, key + "s")}</summary>
          {blocks(body, links)}
        </details>,
      );
      continue;
    }
    if (DETAILS_CLOSE.test(row)) {
      i++;
      continue;
    }
    const heading = row.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      out.push(
        React.createElement(
          "h" + level,
          { key, className: "md-heading" },
          inline(heading[2], links, key),
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(row)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(row) && /^\s*\|?\s*:?-{2,}/.test(rows[i + 1] || "")) {
      const head = cells(row),
        body = [];
      for (i += 2; i < rows.length && /^\s*\|.*\|\s*$/.test(rows[i]); i++)
        body.push(cells(rows[i]));
      out.push(
        <div key={key} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j}>{inline(c, links, `${key}.h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, y) => (
                <tr key={y}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] || "", links, `${key}.${y}.${j}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (/^\s*>/.test(row)) {
      const body = [];
      for (; i < rows.length && /^\s*>/.test(rows[i]); i++)
        body.push(rows[i].replace(/^\s*>\s?/, ""));
      out.push(<blockquote key={key}>{blocks(body, links)}</blockquote>);
      continue;
    }
    if (LIST.test(row)) {
      const items = [];
      for (; i < rows.length; i++) {
        const m = rows[i].match(LIST);
        if (m) items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3] });
        else if (rows[i].trim() && items.length && /^\s+/.test(rows[i]))
          items.at(-1).text += "\n" + rows[i].trim();
        else break;
      }
      out.push(list(items, links, key));
      continue;
    }
    const para = [];
    for (
      ;
      i < rows.length &&
      rows[i].trim() &&
      !LIST.test(rows[i]) &&
      !/^\s*(#{1,6}\s|>|```|~~~)/.test(rows[i]) &&
      !DETAILS_OPEN.test(rows[i]) &&
      !DETAILS_CLOSE.test(rows[i]);
      i++
    )
      para.push(rows[i]);
    out.push(<p key={key}>{lines(para.join("\n"), links, key)}</p>);
  }
  return out;
}
function list(items, links, key) {
  const base = items[0].indent,
    Tag = items[0].ordered ? "ol" : "ul",
    children = [];
  for (let j = 0; j < items.length; j++) {
    const nested = [];
    while (j + 1 < items.length && items[j + 1].indent > base + 1) nested.push(items[++j]);
    children.push({ item: items[nested.length ? j - nested.length : j], nested });
  }
  return (
    <Tag key={key}>
      {children.map(({ item, nested }, y) => (
        <li key={y}>
          {lines(item.text, links, `${key}.${y}`)}
          {nested.length > 0 && list(nested, links, `${key}.${y}n`)}
        </li>
      ))}
    </Tag>
  );
}

/** Renders study text as Markdown; `links={false}` inside clickable surfaces such as cards and options. */
export default function Markdown({ text, links = true, className = "" }) {
  const value = typeof text === "string" ? text : "";
  return <div className={("md " + className).trim()}>{blocks(prepare(value), links)}</div>;
}
