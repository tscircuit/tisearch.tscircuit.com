-- Existing rows and their FTS index are retained. Category/MPN reads use indexes.
CREATE INDEX IF NOT EXISTS parts_category_nocase_idx ON parts(category COLLATE NOCASE, stock DESC);
CREATE INDEX IF NOT EXISTS parts_mpn_nocase_idx ON parts(manufacturer_part_number COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS parts_gpn_idx ON parts(json_extract(raw_json, '$.generic_part_number') COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS parts_inventory_refresh_idx ON parts(updated_at);
CREATE TABLE IF NOT EXISTS catalog_sync (
  family TEXT PRIMARY KEY,
  next_offset INTEGER NOT NULL DEFAULT 0,
  next_sync_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_error TEXT
);

ALTER TABLE parts ADD COLUMN metadata_checked_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS parts_metadata_refresh_idx ON parts(metadata_checked_at);
CREATE TABLE IF NOT EXISTS catalog_pending (
  ti_product_number TEXT PRIMARY KEY,
  information_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Avoid refetching electrical metadata already present in the persisted catalog.
UPDATE parts SET metadata_checked_at = updated_at
WHERE json_type(raw_json, '$.parametrics') = 'object'
  AND json_extract(raw_json, '$.parametrics') != '{}';
