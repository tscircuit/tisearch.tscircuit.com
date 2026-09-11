CREATE TABLE catalog_snapshots (
  id TEXT PRIMARY KEY,
  imported_at INTEGER NOT NULL,
  part_count INTEGER NOT NULL CHECK (part_count > 0),
  currency TEXT NOT NULL
);
CREATE TABLE catalog_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_snapshot TEXT REFERENCES catalog_snapshots(id),
  next_request_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO catalog_state(singleton) VALUES (1);

CREATE TABLE parts (
  id INTEGER PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(id) ON DELETE CASCADE,
  ti_part_number TEXT NOT NULL COLLATE NOCASE,
  generic_part_number TEXT NOT NULL COLLATE NOCASE,
  package TEXT NOT NULL,
  pin_count INTEGER,
  stock INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  categories_json TEXT NOT NULL,
  data_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  UNIQUE(snapshot_id, ti_part_number)
);
CREATE INDEX parts_stock ON parts(snapshot_id, stock DESC, ti_part_number);
CREATE INDEX parts_package ON parts(snapshot_id, package);
CREATE VIRTUAL TABLE parts_fts USING fts5(search_text, content='parts', content_rowid='id');
CREATE TRIGGER parts_insert AFTER INSERT ON parts BEGIN
  INSERT INTO parts_fts(rowid, search_text) VALUES (new.id, new.search_text);
END;
CREATE TRIGGER parts_delete AFTER DELETE ON parts BEGIN
  INSERT INTO parts_fts(parts_fts, rowid, search_text) VALUES ('delete', old.id, old.search_text);
END;
