package io.studyhub.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.studyhub.platform.spi.AppPaths;
import jakarta.annotation.PreDestroy;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;

/** The operation and the generated draft identity are allocated in one SQLite write before any model call. */
@Component
final class ReviewedDraftJournal {
    record Command(String id, String sourceId, String title, List<String> topics,
                   String author, String reviewer, String fallback) {}
    record Entry(String draftId, String jobId, String library, Command command, String source,
                 JsonNode prepared, JsonNode intent, JsonNode receipt, JsonNode background) {
        Entry {
            if (prepared != null && prepared.isNull()) prepared = null;
            if (intent != null && intent.isNull()) intent = null;
            if (receipt != null && receipt.isNull()) receipt = null;
            if (background != null && background.isNull()) background = null;
        }
    }
    static final String PREFIX = "studyhub-reviewed-";
    private final Connection db;
    private final ObjectMapper json;

    ReviewedDraftJournal(AppPaths paths, ObjectMapper json) throws Exception {
        this.json = json;
        var directory = Files.createDirectories(paths.data().resolve("workflows"));
        db = DriverManager.getConnection("jdbc:sqlite:" + directory.resolve("reviewed-drafts.sqlite"));
        try (var stmt = db.createStatement()) {
            stmt.execute("PRAGMA busy_timeout=10000");
            stmt.execute("PRAGMA journal_mode=WAL");
            stmt.execute("PRAGMA synchronous=FULL");
            stmt.execute("CREATE TABLE IF NOT EXISTS draft(draft_id TEXT PRIMARY KEY, library TEXT NOT NULL, command_id TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(library,command_id))");
        }
    }

    synchronized Entry reserve(String library, Command command, String source) throws Exception {
        String uuid = UUID.randomUUID().toString();
        var proposed = new Entry(PREFIX + uuid, "reviewed-" + uuid, library, command, source, null, null, null, null);
        try (var stmt = db.prepareStatement("INSERT INTO draft VALUES(?,?,?,?) ON CONFLICT(library,command_id) DO NOTHING")) {
            stmt.setString(1, proposed.draftId());
            stmt.setString(2, library);
            stmt.setString(3, command.id());
            stmt.setString(4, json.writeValueAsString(proposed));
            stmt.executeUpdate();
        }
        try (var stmt = db.prepareStatement("SELECT document FROM draft WHERE library=? AND command_id=?")) {
            stmt.setString(1, library);
            stmt.setString(2, command.id());
            try (var rows = stmt.executeQuery()) {
                if (!rows.next()) throw new SQLException("Missing draft reservation");
                var row = json.readValue(rows.getString(1), Entry.class);
                if (!row.command().equals(command) || !row.source().equals(source))
                    throw new IllegalStateException("This request id already belongs to different source content or options");
                return row;
            }
        }
    }

    synchronized Entry read(String id) throws Exception {
        try (var stmt = db.prepareStatement("SELECT document FROM draft WHERE draft_id=?")) {
            stmt.setString(1, id);
            try (var rows = stmt.executeQuery()) {
                if (!rows.next()) throw new IllegalStateException("No reviewed draft with this id belongs to the current library");
                return json.readValue(rows.getString(1), Entry.class);
            }
        }
    }

    synchronized Entry write(Entry row) throws Exception {
        try (var stmt = db.prepareStatement("UPDATE draft SET document=? WHERE draft_id=?")) {
            stmt.setString(1, json.writeValueAsString(row));
            stmt.setString(2, row.draftId());
            if (stmt.executeUpdate() != 1) throw new SQLException("Missing reviewed draft");
        }
        return row;
    }

    @PreDestroy void close() throws SQLException { db.close(); }
}
