-- Challenges: friends play the same rounds. Each game in a challenge carries its id.
ALTER TABLE games ADD COLUMN challenge_id TEXT;
CREATE INDEX games_by_challenge ON games (challenge_id) WHERE challenge_id IS NOT NULL;
