-- Fingerprints of what a skin draws (shared/fingerprint.js), to refuse another
-- author's copy, and the skin a declared remix is based on ("<author>.<slug>").
-- Rows from before this migration have a NULL fingerprint until the backfill
-- (scripts/backfill-fingerprints.mjs) fills it in.
ALTER TABLE skins ADD COLUMN fingerprint TEXT;
ALTER TABLE skins ADD COLUMN based_on TEXT;
CREATE INDEX skins_fingerprint ON skins (fingerprint);
