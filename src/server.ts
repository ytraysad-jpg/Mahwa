import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getChapter, getComic, getComics } from "./scraper.js";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e: Error) => res.status(502).json({ error: e.message }));

app.get("/api/home", wrap(async (_q, r) => r.json(await getComics(1))));
app.get("/api/comics", wrap(async (q, r) =>
  r.json(await getComics(Number(q.query.page) || 1, String(q.query.q ?? "").slice(0, 100)))));
app.get("/api/comic/:slug", wrap(async (q, r) => r.json(await getComic(q.params.slug))));
app.get("/api/comic/:slug/chapter/:id", wrap(async (q, r) =>
  r.json(await getChapter(q.params.slug, q.params.id))));

app.use(express.static(path.join(__dirname, "../public")));
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Buka http://localhost:${port}`));
