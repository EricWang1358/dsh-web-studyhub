const normalized = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export function csdnHome(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入 CSDN 公开博客主页链接"); }
  if (url.protocol !== "https:" || url.hostname !== "blog.csdn.net" ||
      !/^\/[\w-]+\/?$/.test(url.pathname) || url.username || url.password || url.port)
    throw new Error("请输入 https://blog.csdn.net/用户名 格式的公开主页");
  return `https://blog.csdn.net/${url.pathname.split("/")[1]}`;
}

export function csdnArticle(value, home) {
  let url;
  try { url = new URL(value); } catch { throw new Error("请输入公开文章链接"); }
  const user = new URL(csdnHome(home)).pathname.split("/")[1];
  if (url.protocol !== "https:" || url.hostname !== "blog.csdn.net" ||
      !new RegExp(`^/${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/article/details/\\d+$`, "i").test(url.pathname))
    throw new Error("文章链接须属于已设置的 CSDN 主页");
  return url.origin + url.pathname;
}

export function csdnMatches(html, title, home) {
  const links = [];
  const pattern = /<a\b[^>]*href=["']([^"']+\/article\/details\/\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    // Public CSDN homepage cards put their title in h4, followed by a long
    // excerpt and statistics inside the same anchor. Match only the title.
    const titleHtml = /<h4\b[^>]*>([\s\S]*?)<\/h4>/i.exec(match[2])?.[1] || match[2];
    const text = titleHtml.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    if (normalized(text) !== normalized(title)) continue;
    try { links.push(csdnArticle(match[1], home)); } catch { /* other author */ }
  }
  return [...new Set(links)];
}

export function csdnArticleIds(html, home) {
  const user = new URL(csdnHome(home)).pathname.split("/")[1];
  const pattern = new RegExp(`https://blog\\.csdn\\.net/${user}/article/details/(\\d+)`, "gi");
  return [...new Set([...html.matchAll(pattern)].map((match) => Number(match[1])))]
    .filter(Number.isSafeInteger);
}

export async function csdnRecentIds(home, fetcher = fetch) {
  const response = await fetcher(csdnHome(home), {
    signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 StudyHub/1.0" },
  });
  if (!response.ok) throw new Error("公开主页暂时无法读取，发布后可手动关联文章链接");
  return csdnArticleIds((await response.text()).slice(0, 2_000_000), home);
}

export async function lookupCsdnArticle(home, title, fetcher = fetch) {
  const response = await fetcher(csdnHome(home), {
    signal: AbortSignal.timeout(10000), headers: { "User-Agent": "Mozilla/5.0 StudyHub/1.0" },
  });
  if (!response.ok) return { matches: [], reason: "公开主页暂时无法读取，请手动粘贴文章链接" };
  const html = (await response.text()).slice(0, 2_000_000);
  const matches = csdnMatches(html, title, home);
  return { matches, matched: matches.length === 1,
    ...(matches.length === 1 ? {} : { reason: matches.length
      ? "找到多篇同名文章，请确认对应链接" : "暂未找到同名新文章，可稍后重试或手动粘贴链接" }) };
}
