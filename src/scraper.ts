// Sumber data: API resmi MangaDex (https://api.mangadex.org). Nama file tetap scraper.ts
// supaya import di server.ts lama tidak rusak.
export const BASE = "https://api.mangadex.org";
export const CDN_HOST = "uploads.mangadex.org";
const UA = "ManhwaReader/2.0 (personal reading project)"; // MangaDex wajib UA unik, jangan pakai UA browser

const csv = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const LANGS = csv(process.env.LANGS, "id,en");                          // urutan = prioritas
const RATINGS = csv(process.env.CONTENT_RATING, "safe,suggestive");
const QUALITY = process.env.IMG_QUALITY === "data" ? "data" : "data-saver";
const LIMIT = 24;
const UUID = /^[0-9a-f-]{36}$/i;

export interface ComicCard { slug: string; title: string; cover?: string }
export interface ChapterRef { id: string; label: string }
export interface ComicDetail {
  slug: string; title: string; cover: string; description: string;
  altTitles: string; chapters: ChapterRef[];
}
export interface ChapterData {
  slug: string; id: string; images: string[]; prev: string | null; next: string | null; debug?: string;
}

// ---- cache 2 lapis: memori -> database SQL (Neon Postgres, opsional via DATABASE_URL) ----
const mem = new Map<string, { t: number; v: unknown }>();
let sqlP: Promise<any> | null = null;
function db(): Promise<any> | null {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  sqlP ??= (async () => {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    await sql`create table if not exists cache (
      key text primary key, value jsonb not null, updated_at timestamptz not null default now())`;
    return sql;
  })();
  return sqlP;
}
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, store = true): Promise<T> {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
  try {
    const sql = await db();
    if (sql && store) {
      const rows = await sql`select value, extract(epoch from now() - updated_at) * 1000 as age
        from cache where key = ${key}`;
      if (rows[0] && Number(rows[0].age) < ttlMs) {
        mem.set(key, { t: Date.now(), v: rows[0].value });
        return rows[0].value as T;
      }
    }
  } catch (e) { console.error("db read:", e); }
  const v = await fn();
  mem.set(key, { t: Date.now(), v });
  if (store) {
    try {
      const sql = await db();
      if (sql) await sql`insert into cache (key, value) values (${key}, ${JSON.stringify(v)}::jsonb)
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    } catch (e) { console.error("db write:", e); }
  }
  return v;
}

// ---- helper API ----
type Q = Record<string, string | number | string[] | undefined>;
async function api<T = any>(path: string, params: Q = {}): Promise<T> {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => u.searchParams.append(k + "[]", x));
    else u.searchParams.set(k, String(v));
  }
  const r = await fetch(u, { headers: { "user-agent": UA } });
  if (r.status === 429) throw new Error("Terlalu banyak permintaan ke MangaDex, coba lagi sebentar.");
  if (!r.ok) throw new Error(`MangaDex HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

const pick = (o?: Record<string, string>) =>
  !o ? "" : o.id ?? o.en ?? Object.values(o)[0] ?? "";

function mapManga(m: any): ComicCard {
  const file = m.relationships?.find((r: any) => r.type === "cover_art")?.attributes?.fileName;
  return {
    slug: m.id,
    title: m.attributes.title?.en ?? pick(m.attributes.title),
    cover: file ? `https://${CDN_HOST}/covers/${m.id}/${file}.512.jpg` : "",
  };
}

// ---- daftar & pencarian ----
export const getComics = (page = 1, q = "") =>
  cached(`list:${page}:${q}`, 10 * 60_000, async () => {
    const r = await api<{ data: any[] }>("/manga", {
      limit: LIMIT, offset: (Math.max(page, 1) - 1) * LIMIT,
      title: q || undefined,
      includes: ["cover_art"], contentRating: RATINGS,
      availableTranslatedLanguage: LANGS, hasAvailableChapters: "true",
      ...(q ? { "order[relevance]": "desc" } : { "order[followedCount]": "desc" }),
    });
    return r.data.map(mapManga);
  });

export const getHome = () => getComics(1);

// ---- detail + chapter ----
export const getComic = (slug: string) =>
  cached(`comic:${slug}`, 30 * 60_000, async (): Promise<ComicDetail> => {
    if (!UUID.test(slug)) throw new Error("ID komik tidak valid");
    const { data } = await api<{ data: any }>(`/manga/${slug}`, { includes: ["cover_art"] });
    const card = mapManga(data);

    const feed: any[] = [];
    for (let offset = 0, total = 1; offset < total && offset < 3000; offset += 500) {
      const f = await api<{ data: any[]; total: number }>(`/manga/${slug}/feed`, {
        limit: 500, offset, translatedLanguage: LANGS, includeExternalUrl: "0",
        "order[chapter]": "desc",
      });
      total = f.total;
      feed.push(...f.data);
    }
    // satu entri per nomor chapter; bahasa prioritas menang
    const byNum = new Map<string, { id: string; lang: string; ch: string | null; title: string }>();
    for (const c of feed) {
      const a = c.attributes;
      if (!a.pages) continue;
      const key = a.chapter ?? c.id;
      const old = byNum.get(key);
      if (!old || LANGS.indexOf(a.translatedLanguage) < LANGS.indexOf(old.lang))
        byNum.set(key, { id: c.id, lang: a.translatedLanguage, ch: a.chapter, title: a.title ?? "" });
    }
    const chapters: ChapterRef[] = [...byNum.values()].map((c) => ({
      id: c.id,
      label: (c.ch ? `Chapter ${c.ch}` : c.title || "Oneshot") +
        (c.lang !== LANGS[0] ? ` (${c.lang.toUpperCase()})` : ""),
    }));
    const alts = (data.attributes.altTitles ?? []).map((o: any) => Object.values(o)[0]).slice(0, 3);
    return {
      slug, title: card.title, cover: card.cover ?? "",
      description: pick(data.attributes.description),
      altTitles: alts.join(" • "),
      chapters, // terbaru dulu
    };
  });

export const getChapter = (slug: string, id: string) =>
  // alamat gambar MangaDex@Home hanya berlaku ± 15 menit: jangan simpan di database
  cached(`chapter:${id}`, 10 * 60_000, async (): Promise<ChapterData> => {
    if (!UUID.test(id)) throw new Error("ID chapter tidak valid");
    const [at, comic] = await Promise.all([api<any>(`/at-home/server/${id}`), getComic(slug)]);
    const files: string[] = QUALITY === "data" ? at.chapter.data : at.chapter.dataSaver;
    const images = files.map((f) => `${at.baseUrl}/${QUALITY}/${at.chapter.hash}/${f}`);
    const i = comic.chapters.findIndex((c) => c.id === id);
    return {
      slug, id, images,
      prev: i >= 0 ? comic.chapters[i + 1]?.id ?? null : null,
      next: i > 0 ? comic.chapters[i - 1].id : null,
    };
  }, false);
