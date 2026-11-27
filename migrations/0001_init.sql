-- One row per game. `data` is the whole game document (JSON); the columns are what we query by.
CREATE TABLE games (
  id         TEXT    PRIMARY KEY,
  user_id    TEXT    NOT NULL,
  version    INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
