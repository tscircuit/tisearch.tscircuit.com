-- JLCSearch keyword matching uses substrings, including inside manufacturer
-- part numbers. A trigram index supports that contract without scanning parts.
CREATE VIRTUAL TABLE parts_substring_fts USING fts5(
  search_text, content='parts', content_rowid='rowid', tokenize='trigram'
);
INSERT INTO parts_substring_fts(parts_substring_fts) VALUES ('rebuild');

CREATE TRIGGER parts_substring_ai AFTER INSERT ON parts BEGIN
  INSERT INTO parts_substring_fts(rowid,search_text) VALUES (new.rowid,new.search_text);
END;
CREATE TRIGGER parts_substring_ad AFTER DELETE ON parts BEGIN
  INSERT INTO parts_substring_fts(parts_substring_fts,rowid,search_text)
  VALUES ('delete',old.rowid,old.search_text);
END;
CREATE TRIGGER parts_substring_au AFTER UPDATE ON parts BEGIN
  INSERT INTO parts_substring_fts(parts_substring_fts,rowid,search_text)
  VALUES ('delete',old.rowid,old.search_text);
  INSERT INTO parts_substring_fts(rowid,search_text) VALUES (new.rowid,new.search_text);
END;
