-- nGen SearchCurrentUserEnquiriesAsync dig-site pin (xLocation / yLocation), persisted for map centering.
ALTER TABLE tickets ADD COLUMN pin_lng REAL;
ALTER TABLE tickets ADD COLUMN pin_lat REAL;
