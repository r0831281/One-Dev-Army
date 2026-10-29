CREATE TABLE should_be_rolled_back(id integer PRIMARY KEY);
INSERT INTO table_that_does_not_exist(id) VALUES (1);
