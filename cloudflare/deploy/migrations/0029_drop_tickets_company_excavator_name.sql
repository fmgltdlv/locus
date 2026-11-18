-- company / excavator_name: not used for FTS or filters; removed from indexed API.

ALTER TABLE tickets DROP COLUMN company;
ALTER TABLE tickets DROP COLUMN excavator_name;
