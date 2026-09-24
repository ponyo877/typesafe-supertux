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
-- Tokens already used for a death or a clear, as hashes, until they expire
-- (plays.js).
CREATE TABLE IF NOT EXISTS used (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,    -- death, clear
  expires INTEGER NOT NULL,
  PRIMARY KEY (id, kind)
);
-- Reports that did not count, and why (verify.js).
CREATE TABLE IF NOT EXISTS rejected (
  mode TEXT NOT NULL,
  reason TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (mode, reason)
);
