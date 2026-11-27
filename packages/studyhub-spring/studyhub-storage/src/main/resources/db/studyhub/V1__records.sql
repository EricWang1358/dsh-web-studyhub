CREATE TABLE study_records (
    library_id TEXT NOT NULL,
    collection TEXT NOT NULL,
    record_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    payload BLOB NOT NULL,
    PRIMARY KEY (library_id, collection, record_id)
) WITHOUT ROWID;

PRAGMA application_id = 0x53544842;
PRAGMA user_version = 1;
