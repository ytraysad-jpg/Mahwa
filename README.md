# Manhwa Reader (Node.js + TypeScript) — sumber: API resmi MangaDex

    npm install && npm run dev      # http://localhost:3000

Environment (opsional):
- DATABASE_URL  : Postgres/Neon, dipakai sebagai cache SQL
- LANGS         : bahasa chapter, urut prioritas (default `id,en`)
- CONTENT_RATING: `safe,suggestive` (default)
- IMG_QUALITY   : `data-saver` (default, hemat kuota) atau `data`
