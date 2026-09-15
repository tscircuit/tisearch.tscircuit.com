-- Cursor scans keep all-parts HTML/JSON responses bounded in Worker memory.
CREATE INDEX IF NOT EXISTS parts_stock_mfr_idx ON parts(stock DESC, manufacturer_part_number);
