import * as cheerio from "cheerio";

export const BASE = "https://01.kaguya.re";
export const CDN_HOST = "storage.kaguyacdn.my.id";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

export interface ComicCard { slug: string; title: string }
export interface ChapterRef { id: string; label: string }
export interface ComicDetail {
  slug: string; title: string; cover: string; description: string;
  altTitles: string; chapters: ChapterRef[];
}
export interface ChapterData {
  slug: string; id: string; images: string[]; prev: string | null; next: string | null;
}

// ---- cache sederhana + delay sopan ----
const cache = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

async function getHtml(path: string): Promise<string> {
  const res = await fetch(BASE + path, { headers: { "user-agent": UA, "accept-language": "id,en;q=0.8" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} untuk ${path}`);
  return res.text();
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function titleFromText(text: string, slug: string): string {
  const t = clean(text);
  // teks kartu biasanya "<judul> <badge> <judul>"
  const m = t.match(/^(.+?)(?:\s+.{0,40}?)?\s*\1$/);
  if (m) return m[1].trim();
  return t || slug.replace(/-/g, " ");
}

function parseCards(html: string): ComicCard[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: ComicCard[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/(?:^|\.re)\/comic\/([^/?#]+)\/?$/);
    if (!m || seen.has(m[1])) return;
    seen.add(m[1]);
    out.push({ slug: m[1], title: titleFromText($(el).text(), m[1]) });
  });
  return out;
}

export const getHome = () =>
  cached("home", 5 * 60_000, async () => parseCards(await getHtml("/")));

export const getComics = (page = 1) =>
  cached(`comics:${page}`, 5 * 60_000, async () =>
    parseCards(await getHtml(`/comics?page=${page}`)));

export const getComic = (slug: string) =>
  cached(`comic:${slug}`, 5 * 60_000, async (): Promise<ComicDetail> => {
    const $ = cheerio.load(await getHtml(`/comic/${encodeURIComponent(slug)}`));
    const chapters: ChapterRef[] = [];
    const seen = new Set<string>();
    $("a[href*='/chapter/']").each((_, el) => {
      const m = ($(el).attr("href") ?? "").match(/\/chapter\/([^/?#]+)/);
      if (!m || seen.has(m[1])) return;
      seen.add(m[1]);
      const label = clean($(el).text()).match(/^(Chapter\s+[\d._]+)/i)?.[1] ?? clean($(el).text());
      chapters.push({ id: m[1], label });
    });
    return {
      slug,
      title: clean($("h1").first().text()) || slug,
      cover: $("meta[property='og:image']").attr("content") ?? "",
      description: $("meta[property='og:description']").attr("content") ?? "",
      altTitles: clean($("h1").first().next().text()),
      chapters, // urutan: terbaru dulu (sesuai situs)
    };
  });

// ---- gambar chapter ----
const IMG_RE = new RegExp(
  `https?:\\\\?/\\\\?/${CDN_HOST.replace(/\./g, "\\.")}[^"'\\s)<>]+?\\.(?:webp|jpe?g|png|avif)`, "gi");

function extractImages(raw: string): string[] {
  const text = raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const found = text.match(IMG_RE) ?? [];
  const uniq = [...new Set(found)];
  // buang cover/logo/hero, sisakan halaman chapter
  return uniq.filter((u) => !/\/(covers|hero-covers|settings|avatars)\//i.test(u));
}

async function renderWithPlaywright(url: string): Promise<string[]> {
  let pw: any;
  try { pw = await import("playwright"); } catch { return []; }
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    // scroll agar lazy-load memuat semua halaman
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
    });
    const srcs: string[] = await page.$$eval("img", (els: any[]) =>
      els.map((e) => e.currentSrc || e.src || e.getAttribute("data-src") || ""));
    return extractImages(srcs.join("\n"));
  } finally {
    await browser.close();
  }
}

export const getChapter = (slug: string, id: string) =>
  cached(`chapter:${id}`, 10 * 60_000, async (): Promise<ChapterData> => {
    const path = `/comic/${encodeURIComponent(slug)}/chapter/${encodeURIComponent(id)}`;
    const raw = await getHtml(path);
    const $ = cheerio.load(raw);

    let images = extractImages(raw);
    if (images.length === 0) images = await renderWithPlaywright(BASE + path);

    const nav = (label: string) => {
      const href = $("a").filter((_, el) => clean($(el).text()) === label).attr("href") ?? "";
      return href.match(/\/chapter\/([^/?#]+)/)?.[1] ?? null;
    };
    return { slug, id, images, prev: nav("Sebelumnya"), next: nav("Selanjutnya") };
  });
