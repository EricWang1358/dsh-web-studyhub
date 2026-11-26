package io.studyhub.sync;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.ObjectReader;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.annotation.JsonInclude;
import io.studyhub.domain.sync.*;
import io.studyhub.storage.StudyDatabase;
import javax.crypto.SecretKey;
import java.io.IOException;
import java.sql.*;
import java.security.GeneralSecurityException;
import java.time.Clock;
import java.time.Instant;
import java.util.*;

/** Durable client-side HLC, immutable encrypted outbox and relay cursor. */
public final class SyncReplica {
    static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();
    static {
        // A v1 reader rejects unknown fields, even null fields. Keep v2-only payloads off v1 packets.
        JSON.configOverride(StudyOp.class).setInclude(JsonInclude.Value.construct(JsonInclude.Include.NON_NULL, JsonInclude.Include.ALWAYS));
    }
    private static final ObjectReader OPERATIONS = JSON.readerFor(StudyOp.class)
        .without(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
        .with(DeserializationFeature.FAIL_ON_NUMBERS_FOR_ENUMS, DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES);
    final PacketJournal journal;
    final UUID vault;
    private final String device;
    private final SecretKey key;
    private final Clock clock;
    private record Position(HybridTime time, long cursor) {}
    private static final UUID KEY_CHECK = UUID.fromString("c8056bba-9b93-4bb4-b9a7-d4c64bdd91f7");
    private static final byte[] CHECK_TEXT = "StudyHub local key check v1".getBytes(java.nio.charset.StandardCharsets.US_ASCII);

    public SyncReplica(StudyDatabase db, UUID vault, String device, SecretKey key, Clock clock) throws SQLException {
        this.journal = new PacketJournal(db);
        this.vault = Objects.requireNonNull(vault); this.device = device;
        this.key = Objects.requireNonNull(key); this.clock = Objects.requireNonNull(clock);
        if (device.isBlank()) throw new IllegalArgumentException("Device is required");
        db.write(c -> {
            var layout = PacketJournal.layout(c);
            verifyKey(c,layout);
            try (var q = c.prepareStatement("INSERT INTO "+layout.clients+" VALUES(?,?,0,0,0) ON CONFLICT(vault) DO NOTHING")) {
                q.setString(1,vault.toString()); q.setString(2,device); q.executeUpdate();
            }
            return position(c,layout);
        });
    }
    private void verifyKey(Connection c, PacketJournal.Layout layout) throws SQLException {
        try (var ddl = c.createStatement()) {
            ddl.executeUpdate("CREATE TABLE IF NOT EXISTS sync_local_keys(vault TEXT PRIMARY KEY, verifier BLOB NOT NULL)");
        }
        try (var q = c.prepareStatement("SELECT verifier FROM sync_local_keys WHERE vault=?")) {
            q.setString(1,vault.toString());
            try (var row = q.executeQuery()) {
                if (row.next()) {
                    byte[] decoded = Packets.decrypt(key,vault,KEY_CHECK,row.getBytes(1));
                    if (!Arrays.equals(decoded,CHECK_TEXT)) throw new SQLException("Incorrect sync key");
                    return;
                }
            }
        } catch (GeneralSecurityException e) { throw new SQLException("Incorrect sync key",e); }
        // Older journals have no verifier. Prove their oldest packet decrypts before accepting the supplied key.
        try (var q = c.prepareStatement("SELECT id,data FROM "+layout.packets+" WHERE vault=? ORDER BY seq LIMIT 1")) {
            q.setString(1,vault.toString());
            try (var row = q.executeQuery()) { if (row.next()) open(UUID.fromString(row.getString(1)),row.getBytes(2)); }
        }
        try (var q = c.prepareStatement("INSERT INTO sync_local_keys VALUES(?,?)")) {
            q.setString(1,vault.toString()); q.setBytes(2,Packets.encrypt(key,vault,KEY_CHECK,CHECK_TEXT)); q.executeUpdate();
        } catch (GeneralSecurityException e) { throw new SQLException("Cannot verify sync key",e); }
    }
    private Position position(Connection c, PacketJournal.Layout layout) throws SQLException {
        try (var q = c.prepareStatement("SELECT device,millis,counter,cursor FROM "+layout.clients+" WHERE vault=?")) {
            q.setString(1,vault.toString());
            try (var row = q.executeQuery()) {
                if (!row.next() || !device.equals(row.getString(1))) throw new SQLException("Replica device mismatch");
                return new Position(new HybridTime(row.getLong(2),row.getLong(3),device),row.getLong(4));
            }
        }
    }
    private void savePosition(Connection c, PacketJournal.Layout layout, HybridTime time, long cursor) throws SQLException {
        try (var q = c.prepareStatement("UPDATE "+layout.clients+" SET millis=?,counter=?,cursor=? WHERE vault=?")) {
            q.setLong(1,time.millis()); q.setLong(2,time.counter()); q.setLong(3,cursor); q.setString(4,vault.toString());
            q.executeUpdate();
        }
    }
    StudyOp open(UUID id, byte[] data) throws SQLException {
        try {
            StudyOp op = OPERATIONS.readValue(Packets.decrypt(key,vault,id,data));
            if (!id.equals(op.id())) throw new SQLException("Operation ID mismatch");
            return op;
        } catch (GeneralSecurityException | IOException | IllegalArgumentException e) {
            throw new SQLException("Unreadable encrypted operation " + id,e);
        }
    }

    public StudyOp record(UUID id, StudyOp.CardKey entity, StudyOp.Kind kind, StudyOp.Answer answer,
                          String field, String value) throws SQLException {
        return issue(id, (c, layout, time, existing) -> new StudyOp(kind.version(),id,time,entity,kind,answer,field,value));
    }

    Instant now() { return clock.instant(); }
    StudyOp find(Connection c, PacketJournal.Layout layout, UUID id) throws SQLException {
        try (var find = c.prepareStatement("SELECT data FROM "+layout.packets+" WHERE vault=? AND id=?")) {
            find.setString(1,vault.toString()); find.setString(2,id.toString());
            try (var row = find.executeQuery()) { return row.next() ? open(id,row.getBytes(1)) : null; }
        }
    }
    @FunctionalInterface
    interface Issue {
        StudyOp build(Connection c, PacketJournal.Layout layout, HybridTime stamp, StudyOp existing) throws SQLException;
    }
    StudyOp issue(UUID id, Issue command) throws SQLException {
        Objects.requireNonNull(id, "Operation ID is required");
        return journal.db.write(c -> {
            var layout = PacketJournal.layout(c);
            var previous = find(c,layout,id);
            var p = position(c,layout);
            var time = previous == null ? HybridTime.next(clock.millis(),device,p.time,null) : previous.stamp();
            var op = command.build(c,layout,time,previous);
            if (previous != null) {
                if (!previous.equals(op)) throw new ConcurrentModificationException("Operation ID already used for another action");
                return previous;
            }
            layout = PacketJournal.requireVersion(c,layout,op.version());
            try {
                PacketJournal.insert(c,layout,vault,id,Packets.encrypt(key,vault,id,JSON.writeValueAsBytes(op)),true);
            } catch (GeneralSecurityException | IOException e) { throw new SQLException("Cannot seal local operation",e); }
            savePosition(c,layout,time,p.cursor);
            return op;
        });
    }

    public long cursor() throws SQLException { return journal.db.read(c -> position(c,PacketJournal.layout(c)).cursor); }
    public List<PacketJournal.Packet> pending() throws SQLException {
        return journal.page(vault,0,PacketJournal.PAGE_LIMIT,true);
    }
    void acknowledge(UUID id) throws SQLException {
        journal.db.write(c -> {
            try (var q = c.prepareStatement("UPDATE "+PacketJournal.layout(c).packets+" SET pending=0 WHERE vault=? AND id=?")) {
                q.setString(1,vault.toString()); q.setString(2,id.toString()); q.executeUpdate();
            }
            return null;
        });
    }

    public void receive(long after, List<PacketJournal.Packet> packets) throws SQLException {
        journal.db.write(c -> {
            var layout = PacketJournal.layout(c);
            var pos = position(c,layout);
            if (after != pos.cursor) throw new ConcurrentModificationException("Relay cursor advanced");
            long cursor = pos.cursor;
            HybridTime time = pos.time;
            for (var packet : packets) {
                if (packet.seq() <= cursor) throw new IllegalArgumentException("Out-of-order relay cursor");
                var op = open(packet.id(),packet.data());
                layout = PacketJournal.requireVersion(c,layout,op.version());
                var row = PacketJournal.insert(c,layout,vault,op.id(),packet.data(),false);
                if (row.inserted()) time = HybridTime.next(clock.millis(),device,time,op.stamp());
                cursor = packet.seq();
            }
            savePosition(c,layout,time,cursor);
            return null;
        });
    }
    public List<StudyOp> operations() throws SQLException {
        return journal.db.read(c -> operations(c,PacketJournal.layout(c)));
    }
    List<StudyOp> operations(Connection c, PacketJournal.Layout layout) throws SQLException {
        List<StudyOp> result = new ArrayList<>();
        try (var q = c.prepareStatement("SELECT id,data FROM "+layout.packets+" WHERE vault=? ORDER BY seq")) {
            q.setString(1,vault.toString());
            try (var rows = q.executeQuery()) {
                while (rows.next()) result.add(open(UUID.fromString(rows.getString(1)),rows.getBytes(2)));
            }
        }
        return List.copyOf(result);
    }
    public CardReplica.View card(StudyOp.CardKey key) throws SQLException { return CardReplica.project(key,operations()); }

    /** Locally stage immutable ciphertext chunks once. Persist the returned descriptors with the attachment manifest. */
    public record Chunk(UUID id, String sha256) {}
    public Chunk stageChunk(io.studyhub.storage.BlobStore spool, byte[] plaintext) throws IOException, GeneralSecurityException {
        UUID id = UUID.randomUUID();
        byte[] sealed = Packets.encrypt(key,vault,id,plaintext);
        return new Chunk(id,spool.put(new java.io.ByteArrayInputStream(sealed)));
    }
    public byte[] openChunk(Chunk descriptor, byte[] sealed) throws GeneralSecurityException {
        if (!descriptor.sha256().equals(Packets.sha256(sealed))) throw new GeneralSecurityException("Wrong chunk digest");
        return Packets.decrypt(key,vault,descriptor.id(),sealed);
    }
}
