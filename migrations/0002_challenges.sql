-- Challenges: friends play the same rounds. Each game in a challenge carries its id.
ALTER TABLE games ADD COLUMN challenge_id TEXT;
CREATE INDEX games_by_challenge ON games (challenge_id) WHERE challenge_id IS NOT NULL;
-- One game per player per challenge: a second concurrent join fails instead of giving a replay.
CREATE UNIQUE INDEX games_one_per_player ON games (challenge_id, user_id) WHERE challenge_id IS NOT NULL;
