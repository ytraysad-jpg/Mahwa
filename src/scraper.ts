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
  debug?: string;
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

const BADGES = new Set(["editors pick","trending","mature","erotica","suggestive","end","hiatus",
  "ongoing","project","premium","new","berlanjut","tamat","manga","manhwa","manhua"]);

function titleFromAnchor($: cheerio.CheerioAPI, el: any, slug: string): string {
  const parts: string[] = [];
  $(el).find("*").addBack().contents().each((_: number, n: any) => {
    if (n.type === "text") {
      const t = clean(n.data ?? "");
      if (t && !BADGES.has(t.toLowerCase())) parts.push(t);
    }
  });
  parts.sort((a, b) => b.length - a.length);
  return parts[0] || slug.replace(/-/g, " ");
}

function parseCards(html: string): ComicCard[] {
  const $ = cheerio.load(html);
  const map = new Map<string, ComicCard>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/(?:^|\.re)\/comic\/([^/?#]+)\/?$/);
    if (!m) return;
    const title = titleFromAnchor($, el, m[1]);
    const old = map.get(m[1]);
    // ganti judul lama kalau masih huruf kecil semua / lebih pendek
    if (!old || old.title === old.title.toLowerCase() || (title.length > old.title.length && /[A-Z]/.test(title)))
      map.set(m[1], { slug: m[1], title });
  });
  return [...map.values()];
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
      let label = "";
      $(el).find("*").addBack().contents().each((_: number, n: any) => {
        if (label || n.type !== "text") return;
        const t = clean(n.data ?? "");
        if (/^Chapter\s+[\d._]+$/i.test(t)) label = t;
      });
      if (!label) return; // lewati "Baca Sekarang" dsb.
      seen.add(m[1]);
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

const BAD = /\/(covers|hero-covers|settings|avatars)\//i;
const REL_RE = /["'(]((?:comics|chapters|uploads)\/[^"'\\\s)<>]+?\.(?:webp|jpe?g|png|avif))/gi;

function extractImages(raw: string): string[] {
  const text = raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const abs = text.match(IMG_RE) ?? [];
  const rel = [...text.matchAll(REL_RE)].map((m) => `https://${CDN_HOST}/${m[1]}`);
  return [...new Set([...abs, ...rel])].filter((u) => !BAD.test(u));
}

function imageSamples(raw: string): string {
  const text = raw.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  const m = [...text.matchAll(/[^"'\s]{0,70}\.(?:webp|jpe?g|png|avif)/gi)].map((x) => x[0]);
  return `cdn=${(text.match(/kaguyacdn/g) ?? []).length}, ext=${m.length}, contoh=[${[...new Set(m)].slice(0, 4).join(" | ")}]`;
}

async function renderWithBrowser(url: string): Promise<{ images: string[]; note: string }> {
  let chromium: any, puppeteer: any;
  try {
    chromium = (await import("@sparticuz/chromium")).default;
    puppeteer = (await import("puppeteer-core")).default;
  } catch (e: any) { return { images: [], note: "import browser gagal: " + e.message }; }
  let browser: any;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
  } catch (e: any) { return { images: [], note: "launch browser gagal: " + e.message }; }
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);
    page.on("request", (r: any) =>
      ["font", "stylesheet", "media"].includes(r.resourceType()) ? r.abort() : r.continue());
    const fromApi: string[] = [];
    const apiUrls: string[] = [];
    page.on("response", async (res: any) => {
      try {
        const t = res.request().resourceType();
        if (t === "xhr" || t === "fetch") apiUrls.push(`${res.status()} ${res.url()}`.slice(0, 160));
        if ((res.headers()["content-type"] ?? "").includes("json"))
          fromApi.push(...extractImages(await res.text()));
      } catch {}
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => {});
    const dom: string[] = await page.$$eval("img", (els: any[]) =>
      els.map((e) => e.currentSrc || e.src || e.getAttribute("data-src") || ""));
    const bodyText: string = await page.evaluate(() => document.body.innerText.slice(0, 200));
    const images = [...new Set([...fromApi, ...extractImages(dom.join("\n"))])];
    return {
      images,
      note: `browser ok, gambar=${images.length}; xhr/fetch=[${apiUrls.slice(0, 8).join(" | ")}]; teks="${bodyText.replace(/\s+/g, " ")}"`,
    };
  } catch (e: any) {
    return { images: [], note: "render gagal: " + e.message };
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
    let debug = `html=${raw.length}b, gambar di html=${images.length}, ${imageSamples(raw)}`;
    if (images.length === 0) {
      const r = await renderWithBrowser(BASE + path);
      images = r.images;
      debug += "; " + r.note;
    }

    const nav = (label: string) => {
      const href = $("a").filter((_, el) => clean($(el).text()) === label).attr("href") ?? "";
      return href.match(/\/chapter\/([^/?#]+)/)?.[1] ?? null;
    };
    return { slug, id, images, prev: nav("Sebelumnya"), next: nav("Selanjutnya"), debug };
  });
