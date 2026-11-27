package io.studyhub.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.studyhub.domain.sync.StudyOp;
import io.studyhub.storage.StudyDatabase;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.*;
import java.util.*;

/** Read-only history of committed desktop records. Node retains ownership of the study library. */
public final class DesktopReviewHistory {
    private static final int INLINE_BYTES = 12 * 1024;
    // Source is the locally bound Node store. Large recorded answers are streamed to encrypted chunks.
    private static final ObjectMapper SOURCE = new ObjectMapper(JsonFactory.builder().streamReadConstraints(
            StreamReadConstraints.builder().maxStringLength(Integer.MAX_VALUE).build()).build());
    private final SyncReplica replica;
    private final EncryptedBlobTree tree;
    private final String library;

    public record Entry(UUID revision, String source, UUID previous, String device, long observedMillis) {}
    public record Page(long next, boolean more, List<Entry> entries) {}
    private record Head(String digest, UUID operation) {}
    private static final class AlreadyCaptured extends RuntimeException {}

    public DesktopReviewHistory(SyncReplica replica, SyncPeer peer, String library) throws Exception {
        if (library == null || library.isBlank() || library.length() > 256)
            throw new IllegalArgumentException("A stable desktop library ID of at most 256 characters is required");
        this.replica = replica;
        this.tree = new EncryptedBlobTree(replica, peer);
        this.library = library;
        replica.journal.db.write(c -> {
            try (var s = c.createStatement()) {
                s.executeUpdate("""
                    CREATE TABLE IF NOT EXISTS desktop_review_heads(
                        vault TEXT NOT NULL, library TEXT NOT NULL, source TEXT NOT NULL,
                        digest TEXT NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(vault,library,source))""");
            }
            return null;
        });
    }

    public void bindSource(Path sourceRoot, String directoryId) throws Exception {
        if (!directoryId.matches("[0-9]+:[0-9]+")) throw new IOException("Unrecognized Node library identity");
        var key = new StudyDatabase.Key(replica.vault.toString(), "desktop-review-root", library);
        var db = replica.journal.db;
        byte[] path = SyncReplica.JSON.writeValueAsBytes(List.of(sourceRoot.toRealPath().toString(), directoryId));
        var previous = db.get(key);
        if (previous.isEmpty()) {
            try { db.save(key, 0, path); return; }
            catch (ConcurrentModificationException raced) { previous = db.get(key); }
        }
        if (!Arrays.equals(previous.orElseThrow().payload(), path))
            throw new IllegalStateException("This desktop sync identity is already bound to a different local library");
    }

    /** The source emits the complete committed envelope. Preserve its original JSON, including unknown fields. */
    public boolean capture(String raw) throws Exception {
        var bytes = raw.getBytes(StandardCharsets.UTF_8);
        var row = SOURCE.readTree(bytes);
        var attempt = row.get("attempt");
        if (attempt == null || !attempt.isObject()) throw new IOException("Missing committed desktop attempt");
        String digest = Packets.sha256(bytes);
        var identity = SyncReplica.JSON.createArrayNode().add(row.path("deck")).add(attempt.path("quiz_id"));
        JsonNode id = attempt.path("id");
        if (id.isMissingNode() || id.isNull() || (id.isTextual() && id.textValue().isEmpty())) {
            if (!row.path("occurrence").canConvertToInt() || row.path("occurrence").intValue() < 0)
                throw new IOException("Missing anonymous desktop attempt occurrence");
            var sorted = SyncReplica.JSON.writer().with(com.fasterxml.jackson.databind.cfg.JsonNodeFeature.WRITE_PROPERTIES_SORTED);
            identity.add("anonymous").add(Packets.sha256(sorted.writeValueAsBytes(attempt))).add(row.path("occurrence"));
        } else {
            identity.add("id").add(id);
            if (row.has("occurrence")) {
                if (!row.get("occurrence").canConvertToInt() || row.get("occurrence").asInt() < 1)
                    throw new IOException("Invalid duplicate named attempt occurrence");
                identity.add(row.get("occurrence"));
            }
        }
        String source = Packets.sha256(SyncReplica.JSON.writeValueAsBytes(identity));
        var old = replica.journal.db.read(c -> head(c, source));
        if (old != null && old.digest().equals(digest)) return false;

        var blob = bytes.length > INLINE_BYTES ? tree.stage(new ByteArrayInputStream(bytes)).manifest() : null;
        UUID op = UUID.randomUUID();
        try {
            replica.issue(op, (c, layout, stamp, existing) -> {
                var before = head(c, source);
                if (before != null && before.digest().equals(digest)) throw new AlreadyCaptured();
                var revision = new DesktopAttemptPacket(source, before == null ? null : before.operation(), blob == null ? raw : null, blob);
                String value;
                try { value = SyncReplica.JSON.writeValueAsString(revision); }
                catch (IOException invalid) { throw new SQLException("Cannot encode revision", invalid); }
                try (var q = c.prepareStatement("""
                    INSERT INTO desktop_review_heads(vault,library,source,digest,operation) VALUES(?,?,?,?,?)
                    ON CONFLICT(vault,library,source) DO UPDATE SET digest=excluded.digest,operation=excluded.operation""")) {
                    q.setString(1, replica.vault.toString()); q.setString(2, library); q.setString(3, source);
                    q.setString(4, digest); q.setString(5, op.toString()); q.executeUpdate();
                }
                return new StudyOp(StudyOp.Kind.DESKTOP_ATTEMPT.version(), op, stamp, null,
                        StudyOp.Kind.DESKTOP_ATTEMPT, null, library, value);
            });
            return true;
        } catch (AlreadyCaptured duplicate) { return false; }
    }

    private Head head(Connection c, String source) throws SQLException {
        try (var q = c.prepareStatement("SELECT digest,operation FROM desktop_review_heads WHERE vault=? AND library=? AND source=?")) {
            q.setString(1, replica.vault.toString()); q.setString(2, library); q.setString(3, source);
            try (var r = q.executeQuery()) { return r.next() ? new Head(r.getString(1), UUID.fromString(r.getString(2))) : null; }
        }
    }

    public Page page(long after, int limit) throws Exception {
        var rows = replica.journal.page(replica.vault, after, limit, false);
        var entries = new ArrayList<Entry>();
        long next = after;
        for (var row : rows) {
            next = row.seq();
            var op = replica.open(row.id(), row.data());
            if (belongs(op)) {
                var v = DesktopAttemptPacket.decode(op);
                entries.add(new Entry(op.id(), v.source(), v.previous(), op.stamp().device(), op.stamp().millis()));
            }
        }
        return new Page(next, rows.size() == limit, List.copyOf(entries));
    }

    public void read(UUID id, OutputStream output) throws Exception {
        StudyOp operation = replica.journal.db.read(c -> replica.find(c, PacketJournal.layout(c), id));
        if (operation == null || !belongs(operation)) throw new NoSuchElementException("Unknown desktop revision");
        var v = DesktopAttemptPacket.decode(operation);
        if (v.inline() != null) output.write(v.inline().getBytes(StandardCharsets.UTF_8));
        else tree.read(v.blob(), output);
    }

    private boolean belongs(StudyOp op) {
        return op.kind() == StudyOp.Kind.DESKTOP_ATTEMPT && library.equals(op.field());
    }
}
