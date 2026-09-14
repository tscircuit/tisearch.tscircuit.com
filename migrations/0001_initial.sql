CREATE TABLE IF NOT EXISTS search_cache (
  cache_key TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL,
  response_key TEXT NOT NULL,
  source_kind TEXT NOT NULL DEFAULT 'search',
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stale_until INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 1,
  api_rate_limit_remaining INTEGER
);

CREATE INDEX IF NOT EXISTS search_cache_refresh_idx
  ON search_cache(expires_at, access_count DESC, last_accessed_at DESC);

CREATE TABLE IF NOT EXISTS parts (
  ti_product_number TEXT PRIMARY KEY,
  manufacturer_part_number TEXT NOT NULL,
  manufacturer TEXT NOT NULL,
  description TEXT NOT NULL,
  detailed_description TEXT,
  package TEXT,
  category_id INTEGER,
  category TEXT,
  subcategory TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  unit_price REAL,
  product_url TEXT,
  datasheet_url TEXT,
  photo_url TEXT,
  normally_stocking INTEGER NOT NULL DEFAULT 0,
  discontinued INTEGER NOT NULL DEFAULT 0,
  marketplace INTEGER NOT NULL DEFAULT 0,
  parameters_json TEXT NOT NULL DEFAULT '{}',
  search_text TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS parts_stock_idx ON parts(stock DESC);
CREATE INDEX IF NOT EXISTS parts_package_idx ON parts(package, stock DESC);
CREATE INDEX IF NOT EXISTS parts_category_idx
  ON parts(category, subcategory, stock DESC);
CREATE INDEX IF NOT EXISTS parts_mpn_idx ON parts(manufacturer_part_number);

CREATE VIRTUAL TABLE IF NOT EXISTS parts_fts USING fts5(
  ti_product_number UNINDEXED,
  search_text,
  content='parts',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS parts_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, ti_product_number, search_text)
  VALUES (new.rowid, new.ti_product_number, new.search_text);
END;
CREATE TRIGGER IF NOT EXISTS parts_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, ti_product_number, search_text)
  VALUES ('delete', old.rowid, old.ti_product_number, old.search_text);
END;

CREATE TRIGGER IF NOT EXISTS parts_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, ti_product_number, search_text)
  VALUES ('delete', old.rowid, old.ti_product_number, old.search_text);
  INSERT INTO parts_fts(rowid, ti_product_number, search_text)
  VALUES (new.rowid, new.ti_product_number, new.search_text);
END;
