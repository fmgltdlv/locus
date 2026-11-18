-- Replace dig_site_* split columns with first-class locality columns; keep full_address as canonical line.
-- Migrate existing values before DROP (SQLite).

ALTER TABLE tickets ADD COLUMN city TEXT;
ALTER TABLE tickets ADD COLUMN state TEXT;
ALTER TABLE tickets ADD COLUMN county TEXT;
ALTER TABLE tickets ADD COLUMN zipcode TEXT;

UPDATE tickets
SET city = dig_site_city
WHERE dig_site_city IS NOT NULL AND TRIM(dig_site_city) != ''
  AND (city IS NULL OR TRIM(city) = '');

UPDATE tickets
SET state = dig_site_state
WHERE dig_site_state IS NOT NULL AND TRIM(dig_site_state) != ''
  AND (state IS NULL OR TRIM(state) = '');

UPDATE tickets
SET county = dig_site_county
WHERE dig_site_county IS NOT NULL AND TRIM(dig_site_county) != ''
  AND (county IS NULL OR TRIM(county) = '');

UPDATE tickets
SET zipcode = dig_site_postcode
WHERE dig_site_postcode IS NOT NULL AND TRIM(dig_site_postcode) != ''
  AND (zipcode IS NULL OR TRIM(zipcode) = '');

ALTER TABLE tickets DROP COLUMN dig_site_prefix;
ALTER TABLE tickets DROP COLUMN dig_site_street;
ALTER TABLE tickets DROP COLUMN dig_site_city;
ALTER TABLE tickets DROP COLUMN dig_site_postcode;
ALTER TABLE tickets DROP COLUMN dig_site_state;
ALTER TABLE tickets DROP COLUMN dig_site_county;
