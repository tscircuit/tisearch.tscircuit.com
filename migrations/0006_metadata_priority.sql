-- Select the next enrichment target without sorting/parsing the entire pending
-- catalog on every alarm. These indexes also track inventory/metadata updates.
CREATE INDEX parts_specification_priority_idx ON parts (
  specification_status,
  CASE WHEN stock>0 AND COALESCE(json_array_length(raw_json,'$.category_routes'),0)>0 THEN 0
       WHEN stock>0 THEN 1 ELSE 2 END,
  stock DESC,
  ti_product_number
);
CREATE INDEX parts_information_priority_idx ON parts (
  information_status,
  CASE WHEN stock>0 AND COALESCE(json_array_length(raw_json,'$.category_routes'),0)>0 THEN 0
       WHEN stock>0 THEN 1 ELSE 2 END,
  stock DESC,
  ti_product_number
);
