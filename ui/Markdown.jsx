import { ui, uiFormat } from "./i18n.js";
import { TERM_SOURCE } from "./term-marker.js";
import { Button } from "./components/Button.jsx";
import Tooltip from "./components/Tooltip.jsx";
import React from "react";
import { prepareStudyMath, STUDY_IMAGE_PATTERN } from "./study-media.js";
import StudyMath from "./StudyMath.jsx";
import StudyImage from "./StudyImage.jsx";

/**
 * Safe Markdown for study text: builds React elements (source HTML is never
 * parsed or injected). Formula markup comes only from local untrusted KaTeX.
 * Single newlines are line breaks, matching chat-style model output.
 */
const COLOR_OPEN = "c",
  COLOR_MID = "",
  COLOR_CLOSE = "/c";
const INLINE = [
  ["code", /`([^`\n]+)`/],
  ["term", new RegExp(TERM_SOURCE)],
  ["math", /\uE000(\d+)\uE001/],
  ["image", STUDY_IMAGE_PATTERN],
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

function inline(text, options, key = "i") {
  const out = [];
  let rest = text.replace(//g, " "),
    n = 0;
  while (rest) {
    let best = null;
    for (const [type, re] of INLINE) {
      // `[[term]]` is a button only where a handler is given; elsewhere it stays the text it was written as.
      if (type === "term" && !options.onTerm) continue;
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
    else if (type === "math") out.push(<StudyMath key={k} formula={options.formulas[Number(m[1])]} />);
    else if (type === "image") out.push(<StudyImage key={k} alt={m[1]} src={m[2] || m[3]} interactive={options.mediaInteractive} />);
    else if (type === "term") {
      const term = m[1],
        asked = options.askedTerms?.includes(term);
      out.push(
        <Tooltip key={k} layer group="ask-help" content={ui("只用选中的这段原文解释这个词；答案会开在这条回答下面。点击前不会提问。")}>
          <Button
            variant="link"
            size="sm"
            className={asked ? "md-term md-term--asked" : "md-term"}
            aria-label={uiFormat("追问「{0}」", [term])}
            onClick={() => options.onTerm(term)}
          >
            {term}
          </Button>
        </Tooltip>,
      );
    } else if (type === "color")
      out.push(
        <span key={k} className="md-color" style={{ color: m[1] }}>
          {inline(m[2], options, k)}
        </span>,
      );
    else if (type === "strong" || type === "em" || type === "del")
      out.push(React.createElement(type, { key: k }, inline(m[1], options, k)));
    else {
      const label = type === "link" ? inline(m[1], options, k) : m[0],
        href = safeHref(type === "link" ? m[2] : m[0]);
      out.push(
        options.links && href ? (
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
function lines(text, options, key) {
  // Newlines and <br> (marked ) are both line breaks inside a block.
  return text
    .split(/[\n]/)
    .flatMap((line, i) =>
      i
        ? [<br key={`${key}.br${i}`} />, ...inline(line, options, `${key}.${i}`)]
        : inline(line, options, `${key}.${i}`),
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

function blocks(rows, options) {
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
          <summary>{inline(summary || ui("详情"), options, key + "s")}</summary>
          {blocks(body, options)}
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
          inline(heading[2], options, key),
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
                  <th key={j}>{inline(c, options, `${key}.h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, y) => (
                <tr key={y}>
                  {head.map((_, j) => (
                    <td key={j}>{inline(r[j] || "", options, `${key}.${y}.${j}`)}</td>
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
      out.push(<blockquote key={key}>{blocks(body, options)}</blockquote>);
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
      out.push(list(items, options, key));
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
    out.push(<p key={key}>{lines(para.join("\n"), options, key)}</p>);
  }
  return out;
}
function list(items, options, key) {
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
          {lines(item.text, options, `${key}.${y}`)}
          {nested.length > 0 && list(nested, options, `${key}.${y}n`)}
        </li>
      ))}
    </Tag>
  );
}

/** Renders study text as Markdown; `links={false}` inside clickable surfaces such as cards and options. */
export default function Markdown({ text, links = true, mediaInteractive = links, className = "", onTerm, askedTerms }) {
  const content = React.useMemo(() => {
    const { value, formulas } = prepareStudyMath(typeof text === "string" ? text : "");
    return blocks(prepare(value), { links, mediaInteractive, formulas, onTerm, askedTerms });
  }, [text, links, mediaInteractive, onTerm, askedTerms]);
  return <div className={("md " + className).trim()}>{content}</div>;
}
