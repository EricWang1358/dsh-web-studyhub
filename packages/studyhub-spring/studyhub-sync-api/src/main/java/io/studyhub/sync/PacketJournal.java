package io.studyhub.sync;

import io.studyhub.storage.StudyDatabase;
import java.sql.*;
import java.util.*;

/** Append-only ciphertext log; monotonically increasing cursors are assigned on the relay. */
public final class PacketJournal {
    final StudyDatabase db;
    public record Packet(long seq, UUID id, byte[] data) {}
    public record Append(long seq, boolean inserted) {}
    public static final int PAGE_LIMIT = 64;
    enum Layout {
        V1("sync_packets", "sync_clients"), V2("sync_packets_v2", "sync_clients_v2");
        final String packets, clients;
        Layout(String packets, String clients) { this.packets = packets; this.clients = clients; }
    }

    static Layout layout(Connection c) throws SQLException {
        try (var s = c.createStatement(); var r = s.executeQuery("SELECT version FROM sync_version")) {
            if (!r.next()) throw new SQLException("Missing sync journal version");
            var result = switch (r.getString(1)) {
                case "1" -> Layout.V1;
                case "2" -> Layout.V2;
                default -> throw new SQLException("Unknown sync journal version");
            };
            if (r.next()) throw new SQLException("Ambiguous sync journal version");
            return result;
        }
    }

    /** Fence an already-running v1 process as well as one reopening after a new operation was committed. */
    static Layout requireVersion(Connection c, Layout current, int version) throws SQLException {
        if (version == 2 && current == Layout.V1) {
            try (var s = c.createStatement()) {
                s.executeUpdate("ALTER TABLE sync_packets RENAME TO sync_packets_v2");
                s.executeUpdate("ALTER TABLE sync_clients RENAME TO sync_clients_v2");
                s.executeUpdate("UPDATE sync_version SET version=2 WHERE version=1");
            }
            return Layout.V2;
        }
        return current;
    }

    public PacketJournal(StudyDatabase db) throws SQLException {
        this.db = db;
        db.write(c -> {
            try (var s = c.createStatement()) {
                boolean newJournal;
                try (var r = s.executeQuery("SELECT 1 FROM sqlite_master WHERE name='sync_version'")) {
                    newJournal = !r.next();
                }
                if (newJournal) {
                    s.executeUpdate("CREATE TABLE sync_version(version INTEGER PRIMARY KEY)");
                    s.executeUpdate("INSERT INTO sync_version VALUES(1)");
                }
                if (layout(c) == Layout.V2) return null;
                s.executeUpdate("""
                    CREATE TABLE IF NOT EXISTS sync_packets (
                        seq INTEGER PRIMARY KEY, vault TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL,
                        pending INTEGER NOT NULL DEFAULT 0, UNIQUE(vault,id))""");
                s.executeUpdate("CREATE INDEX IF NOT EXISTS sync_page ON sync_packets(vault,seq)");
                s.executeUpdate("""
                    CREATE TABLE IF NOT EXISTS sync_clients (
                        vault TEXT PRIMARY KEY, device TEXT NOT NULL, millis INTEGER NOT NULL,
                        counter INTEGER NOT NULL, cursor INTEGER NOT NULL)""");
            }
            return null;
        });
    }
    static Append insert(Connection c, Layout layout, UUID vault, UUID id, byte[] data, boolean pending) throws SQLException {
        Packets.check(data);
        int inserted;
        try (var add = c.prepareStatement("INSERT INTO "+layout.packets+"(vault,id,data,pending) VALUES(?,?,?,?) ON CONFLICT(vault,id) DO NOTHING")) {
            add.setString(1,vault.toString()); add.setString(2,id.toString()); add.setBytes(3,data); add.setBoolean(4,pending);
            inserted = add.executeUpdate();
        }
        try (var find = c.prepareStatement("SELECT seq,data FROM "+layout.packets+" WHERE vault=? AND id=?")) {
            find.setString(1,vault.toString()); find.setString(2,id.toString());
            try (var rows = find.executeQuery()) {
                if (!rows.next()) throw new SQLException("Appended packet missing");
                if (inserted == 0 && !Arrays.equals(data, rows.getBytes(2)))
                    throw new ConcurrentModificationException("Conflicting operation ID");
                return new Append(rows.getLong(1), inserted == 1);
            }
        }
    }
    public Append append(UUID vault, UUID id, byte[] data) throws SQLException {
        return db.write(c -> insert(c, layout(c), vault, id, data, false));
    }
    public List<Packet> page(UUID vault, long after, int limit, boolean pendingOnly) throws SQLException {
        if (after < 0 || limit < 1 || limit > PAGE_LIMIT) throw new IllegalArgumentException("Invalid page");
        return db.read(c -> {
            String sql = "SELECT seq,id,data FROM "+layout(c).packets+" WHERE vault=? AND seq>? "
                + (pendingOnly ? "AND pending=1 " : "") + "ORDER BY seq LIMIT ?";
            try (var q = c.prepareStatement(sql)) {
                q.setString(1,vault.toString()); q.setLong(2,after); q.setInt(3,limit);
                try (var rows = q.executeQuery()) {
                    List<Packet> result = new ArrayList<>();
                    while (rows.next()) result.add(new Packet(rows.getLong(1),UUID.fromString(rows.getString(2)),rows.getBytes(3)));
                    return List.copyOf(result);
                }
            }
        });
    }
}
