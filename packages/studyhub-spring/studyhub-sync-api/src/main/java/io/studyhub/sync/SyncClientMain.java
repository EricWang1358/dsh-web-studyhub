package io.studyhub.sync;

import io.studyhub.domain.sync.*;
import io.studyhub.storage.StudyDatabase;

import java.net.URI;
import java.net.http.WebSocket;
import java.nio.file.Path;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;

/** Command-line client for disconnected review and encrypted replication. Secrets are read only from the environment. */
public final class SyncClientMain {
    private SyncClientMain() {}
    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Set " + name);
        return value;
    }
    public static void main(String[] argv) throws Exception {
        List<String> args = Arrays.stream(argv).filter(a -> !a.startsWith("--studyhub.mode=")).toList();
        if (args.isEmpty() || args.getFirst().equals("help")) {
            System.out.println("""
                StudyHub sync client
                  attempt <library> <course> <card> <grade 0..5> <operation-uuid> [ISO-instant] [zone-id]
                  undo <library> <course> <card> <attempt-uuid> <operation-uuid>
                  correct <library> <course> <card> <attempt-uuid> <grade 0..5> <operation-uuid>
                  show <library> <course> <card>
                  backup-put <Node-export.json>
                  backup-get <backup-uuid> <new-file.json>
                  backup-list
                  sync
                  watch
                Set STUDYHUB_SYNC_DB, STUDYHUB_SYNC_VAULT, STUDYHUB_SYNC_DEVICE and STUDYHUB_SYNC_KEY
                (base64-encoded 32-byte key). sync/watch additionally use STUDYHUB_SYNC_URL and STUDYHUB_SYNC_TOKEN.
                """);
            return;
        }
        try (var db = StudyDatabase.open(Path.of(required("STUDYHUB_SYNC_DB")))) {
            var replica = new SyncReplica(db,UUID.fromString(required("STUDYHUB_SYNC_VAULT")),required("STUDYHUB_SYNC_DEVICE"),
                Packets.key(Base64.getDecoder().decode(required("STUDYHUB_SYNC_KEY"))),Clock.systemUTC());
            var reviews = new RecordReviewAttempt(replica);
            switch (args.getFirst()) {
                case "attempt" -> {
                    if (args.size() < 6 || args.size() > 8) throw new IllegalArgumentException("See sync-client help");
                    var id = UUID.fromString(args.get(5));
                    Instant at = args.size() > 6 ? Instant.parse(args.get(6)) : null;
                    var zone = args.size() > 7 ? ZoneId.of(args.get(7)) : null;
                    var op = reviews.record(id,card(args),Integer.parseInt(args.get(4)),at,zone,null);
                    System.out.println(op.id());
                }
                case "undo" -> {
                    if (args.size() != 6) throw new IllegalArgumentException("See sync-client help");
                    var op = reviews.undo(UUID.fromString(args.get(5)),card(args),UUID.fromString(args.get(4)));
                    System.out.println(op.id());
                }
                case "correct" -> {
                    if (args.size() != 7) throw new IllegalArgumentException("See sync-client help");
                    var op = reviews.correct(UUID.fromString(args.get(6)),card(args),UUID.fromString(args.get(4)),Integer.parseInt(args.get(5)));
                    System.out.println(op.id());
                }
                case "show" -> {
                    if (args.size() != 4) throw new IllegalArgumentException("See sync-client help");
                    System.out.println(SyncReplica.JSON.writeValueAsString(replica.card(card(args))));
                }
                case "backup-put", "backup-get", "backup-list" -> {
                    var peer = new SyncPeer(replica,URI.create(required("STUDYHUB_SYNC_URL")),required("STUDYHUB_SYNC_TOKEN"));
                    var backups = new NodeBackup(replica,peer);
                    switch (args.getFirst()) {
                        case "backup-put" -> {
                            if (args.size() != 2) throw new IllegalArgumentException("See sync-client help");
                            System.out.println(backups.upload(Path.of(args.get(1))));
                        }
                        case "backup-get" -> {
                            if (args.size() != 3) throw new IllegalArgumentException("See sync-client help");
                            backups.download(UUID.fromString(args.get(1)),Path.of(args.get(2)));
                        }
                        default -> {
                            peer.sync();
                            for (var op : replica.operations()) if (op.kind() == StudyOp.Kind.BACKUP)
                                System.out.println(op.id() + " " + op.value());
                        }
                    }
                }
                case "sync", "watch" -> {
                    if (args.size() != 1) throw new IllegalArgumentException("See sync-client help");
                    var peer = new SyncPeer(replica,URI.create(required("STUDYHUB_SYNC_URL")),required("STUDYHUB_SYNC_TOKEN"));
                    if (args.getFirst().equals("sync")) { peer.sync(); System.out.println("cursor " + replica.cursor()); }
                    else watch(peer);
                }
                default -> throw new IllegalArgumentException("Unknown sync-client command");
            }
        }
    }
    private static StudyOp.CardKey card(List<String> args) { return new StudyOp.CardKey(args.get(1),args.get(2),args.get(3)); }
    private static void watch(SyncPeer peer) throws Exception {
        var wake = new ArrayBlockingQueue<Boolean>(1);
        while (!Thread.currentThread().isInterrupted()) {
            WebSocket socket = null;
            try {
                socket = peer.subscribe(message -> wake.offer(true)).get(35,TimeUnit.SECONDS);
                do {
                    peer.sync();
                    wake.poll(20,TimeUnit.SECONDS);
                } while (!socket.isInputClosed() && !socket.isOutputClosed());
            } catch (java.io.IOException | ExecutionException | TimeoutException e) {
                // Local outbox and cursor survive link failure. Poll also catches changes issued by another local process.
                System.err.println("Relay disconnected; reconnecting in 5 seconds");
                Thread.sleep(5000);
            } finally { if (socket != null) socket.abort(); }
        }
    }
}
