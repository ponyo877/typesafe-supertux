-- Everyone's plays, counted (see worker.js). Apply with
--   wrangler d1 execute supertux-stats --remote --file tools/web/cloudflare/schema.sql
CREATE TABLE IF NOT EXISTS counts (
  mode TEXT NOT NULL,
  kind TEXT NOT NULL,    -- attempt, death, clear
  n INTEGER NOT NULL,
  PRIMARY KEY (mode, kind)
);
CREATE TABLE IF NOT EXISTS deaths (
  mode TEXT NOT NULL,
  tx INTEGER NOT NULL,   -- tile (32 px) where the player died
  ty INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (mode, tx, ty)
);
