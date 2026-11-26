package io.studyhub.storage;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.flywaydb.core.Flyway;
import org.springframework.data.annotation.Version;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.*;
import java.util.ConcurrentModificationException;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantLock;

/** Versioned SQLite database with short IMMEDIATE writer transactions and WAL snapshot readers. */
public final class StudyDatabase implements AutoCloseable {
    public static final int SCHEMA_VERSION = 1;
    private static final int APP_ID = 0x53544842;
    private static final ReentrantLock OPEN = new ReentrantLock();
    private final Path file;
    private final HikariDataSource readers;
    private final HikariDataSource writer;

    private StudyDatabase(Path file, HikariDataSource readers, HikariDataSource writer) {
        this.file = file;
        this.readers = readers;
        this.writer = writer;
    }

    public Path path() { return file; }

    public static StudyDatabase open(Path requested) throws SQLException, IOException {
        Path file = requested.toAbsolutePath().normalize();
        Files.createDirectories(file.getParent());
        file = Files.exists(file) ? file.toRealPath() : file.getParent().toRealPath().resolve(file.getFileName());
        // Flyway creates its history table before V1 assigns application_id. Another opener must not
        // mistake that short-lived state for a foreign database. File locks survive process crashes.
        Path lockFile = file.resolveSibling(file.getFileName() + ".open.lock");
        OPEN.lock();
        try (var channel = FileChannel.open(lockFile, StandardOpenOption.CREATE, StandardOpenOption.WRITE);
             var held = channel.lock()) {
            return openLocked(file);
        } finally { OPEN.unlock(); }
    }

    private static StudyDatabase openLocked(Path file) throws SQLException, IOException {
        String url = "jdbc:sqlite:" + file.toUri().toASCIIString() + "?busy_timeout=10000&foreign_keys=on";
        if (Files.exists(file) && Files.size(file) > 0) {
            try (Connection db = DriverManager.getConnection(url + "&mode=ro")) {
                checkSchema(db, true);
            }
        }
        // Recheck under SQLite's write lock, including when creating the file for the first time.
        try (Connection db = DriverManager.getConnection(url); Statement sql = db.createStatement()) {
            sql.execute("BEGIN IMMEDIATE");
            try { checkSchema(db, true); } finally { sql.execute("ROLLBACK"); }
        }
        Flyway.configure().dataSource(url, null, null).locations("classpath:db/studyhub")
            .ignoreMigrationPatterns(new String[0]).load().migrate();
        try (Connection db = DriverManager.getConnection(url); Statement sql = db.createStatement()) {
            checkSchema(db, false);
            try (ResultSet rows = sql.executeQuery("PRAGMA journal_mode=WAL")) {
                if (!rows.next() || !"wal".equalsIgnoreCase(rows.getString(1))) throw new SQLException("SQLite WAL unavailable");
            }
        }
        HikariDataSource writer = pool(url + "&transaction_mode=IMMEDIATE", 1, false);
        try {
            return new StudyDatabase(file.toRealPath(), pool(url, 4, true), writer);
        } catch (RuntimeException | IOException e) {
            writer.close();
            throw e;
        }
    }

    private static HikariDataSource pool(String url, int limit, boolean readOnly) {
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl(url);
        cfg.setMinimumIdle(0);
        cfg.setMaximumPoolSize(limit);
        if (readOnly) cfg.setConnectionInitSql("PRAGMA query_only=ON");
        return new HikariDataSource(cfg);
    }

    private static void checkSchema(Connection db, boolean allowEmpty) throws SQLException {
        try (Statement sql = db.createStatement()) {
            int appId = scalar(sql, "PRAGMA application_id");
            int version = scalar(sql, "PRAGMA user_version");
            if (appId == APP_ID && version == SCHEMA_VERSION) return;
            if (allowEmpty && appId == 0 && version == 0 &&
                scalar(sql, "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'") == 0) return;
            throw new SQLException("Unsupported StudyHub database (application_id=" + appId + ", user_version=" + version + ")");
        }
    }

    private static int scalar(Statement sql, String query) throws SQLException {
        try (ResultSet rows = sql.executeQuery(query)) { rows.next(); return rows.getInt(1); }
    }

    @FunctionalInterface
    public interface Transaction<T> { T apply(Connection connection) throws SQLException; }

    public <T> T read(Transaction<T> query) throws SQLException { return within(readers, query); }
    public <T> T write(Transaction<T> update) throws SQLException { return within(writer, update); }

    private static <T> T within(HikariDataSource pool, Transaction<T> action) throws SQLException {
        try (Connection db = pool.getConnection()) {
            db.setAutoCommit(false);
            try {
                checkSchema(db, false);
                T result = action.apply(db);
                db.commit();
                return result;
            } catch (SQLException | RuntimeException | Error e) {
                try { db.rollback(); } catch (SQLException rollback) { e.addSuppressed(rollback); }
                throw e;
            }
        }
    }

    public record Key(String libraryId, String collection, String recordId) {
        public Key {
            if (libraryId.isBlank() || collection.isBlank() || recordId.isBlank())
                throw new IllegalArgumentException("Library, collection and record ID are required");
        }
        private void bind(PreparedStatement sql, int i) throws SQLException {
            sql.setString(i, libraryId); sql.setString(i + 1, collection); sql.setString(i + 2, recordId);
        }
    }
    public record Entry(@Version long version, byte[] payload) {
        public Entry { payload = payload.clone(); }
        @Override public byte[] payload() { return payload.clone(); }
    }

    public Optional<Entry> get(Key key) throws SQLException {
        return read(db -> {
            try (PreparedStatement sql = db.prepareStatement(
                "SELECT version, payload FROM study_records WHERE library_id=? AND collection=? AND record_id=?")) {
                key.bind(sql, 1);
                try (ResultSet rows = sql.executeQuery()) {
                    return rows.next() ? Optional.of(new Entry(rows.getLong(1), rows.getBytes(2))) : Optional.empty();
                }
            }
        });
    }

    /** expectedVersion=0 creates a new record. A conflicting edit leaves the stored bytes untouched. */
    public long save(Key key, long expectedVersion, byte[] payload) throws SQLException {
        Objects.requireNonNull(payload);
        if (expectedVersion < 0 || expectedVersion == Long.MAX_VALUE) throw new IllegalArgumentException("Invalid version");
        boolean create = expectedVersion == 0;
        String query = create
            ? "INSERT INTO study_records(payload, library_id, collection, record_id, version) VALUES(?,?,?,?,1) ON CONFLICT DO NOTHING"
            : "UPDATE study_records SET payload=?, version=version+1 WHERE library_id=? AND collection=? AND record_id=? AND version=?";
        return write(db -> {
            try (PreparedStatement sql = db.prepareStatement(query)) {
                sql.setBytes(1, payload);
                key.bind(sql, 2);
                if (!create) sql.setLong(5, expectedVersion);
                if (sql.executeUpdate() != 1) throw new ConcurrentModificationException(key.toString());
                return expectedVersion + 1;
            }
        });
    }

    @Override public void close() { readers.close(); writer.close(); }
}
