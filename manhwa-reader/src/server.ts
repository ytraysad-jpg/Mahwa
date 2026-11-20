import express from "express";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { BASE, CDN_HOST, getChapter, getComic, getComics, getHome } from "./scraper.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: Error) => res.status(502).json({ error: e.message }));

app.get("/api/home", wrap(async (_q, r) => r.json(await getHome())));
app.get("/api/comics", wrap(async (q, r) => r.json(await getComics(Number(q.query.page) || 1))));
app.get("/api/comic/:slug", wrap(async (q, r) => r.json(await getComic(q.params.slug))));
app.get("/api/comic/:slug/chapter/:id", wrap(async (q, r) =>
  r.json(await getChapter(q.params.slug, q.params.id))));

// redirect ke cover (lazy) lewat proxy gambar
app.get("/api/cover/:slug", wrap(async (q, r) => {
  const c = await getComic(q.params.slug);
  c.cover ? r.redirect(`/api/img?u=${encodeURIComponent(c.cover)}`) : r.status(404).end();
}));

// proxy gambar (hanya host CDN Kaguya) agar tidak kena blokir hotlink/referer
app.get("/api/img", async (req, res) => {
  try {
    const u = new URL(String(req.query.u));
    if (u.hostname !== CDN_HOST) return res.status(400).end();
    const up = await fetch(u, { headers: { referer: BASE + "/", "user-agent": "Mozilla/5.0" } });
    if (!up.ok || !up.body) return res.status(up.status).end();
    res.setHeader("content-type", up.headers.get("content-type") ?? "image/webp");
    res.setHeader("cache-control", "public, max-age=86400");
    Readable.fromWeb(up.body as any).pipe(res);
  } catch { res.status(400).end(); }
});

app.use(express.static(path.join(__dirname, "../public")));
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Buka http://localhost:${port}`));
