-- Track metadata independently from stock freshness; no parts are inserted.
ALTER TABLE parts ADD COLUMN information_checked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parts ADD COLUMN information_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE parts ADD COLUMN specification_status TEXT NOT NULL DEFAULT 'pending';
UPDATE parts SET specification_status='available'
WHERE json_type(raw_json,'$.parametrics')='object'
AND json_extract(raw_json,'$.parametrics')!='{}';
CREATE INDEX parts_information_pending_idx ON parts(information_status,ti_product_number);
CREATE INDEX parts_specification_pending_idx ON parts(specification_status,ti_product_number);
