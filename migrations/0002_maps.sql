-- The playable maps and their locations (true coordinates). Loaded from data/locations.json by
-- `npm run locations:upload`, so the answers never go through git and the Worker builds from the repo alone.
CREATE TABLE maps (
  id         TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
