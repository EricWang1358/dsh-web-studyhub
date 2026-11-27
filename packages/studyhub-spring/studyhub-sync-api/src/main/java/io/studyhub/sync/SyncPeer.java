package io.studyhub.sync;

import io.studyhub.storage.BlobStore;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.sql.SQLException;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;

/** Network client for a single private, single-user vault. Sync keys never leave the replica. */
public final class SyncPeer {
    private final SyncReplica replica;
    private final HttpClient http;
    private final URI endpoint;
    private final String authorization;
    private static final Duration TIMEOUT = Duration.ofSeconds(30);

    public SyncPeer(SyncReplica replica, URI server, String bearer) {
        this.replica = replica;
        boolean loopback = Set.of("localhost","127.0.0.1","[::1]").contains(Objects.requireNonNull(server.getHost()));
        if (!("https".equals(server.getScheme()) || (loopback && "http".equals(server.getScheme())))
            || server.getUserInfo() != null || server.getQuery() != null || server.getFragment() != null)
            throw new IllegalArgumentException("Use HTTPS or a loopback HTTP relay address");
        this.endpoint = URI.create(server.toString().replaceAll("/+$","") + "/sync/v1/vaults/" + replica.vault + "/");
        this.authorization = "Bearer " + bearer;
        this.http = HttpClient.newBuilder().connectTimeout(TIMEOUT).build();
    }
    private HttpRequest.Builder request(String path) {
        return HttpRequest.newBuilder(endpoint.resolve(path)).timeout(TIMEOUT).header("Authorization",authorization);
    }
    private static void check(int status) throws IOException {
        if (status < 200 || status >= 300) throw new IOException("Sync relay returned HTTP " + status);
    }
    private byte[] get(String path) throws IOException, InterruptedException {
        var result = http.send(request(path).GET().build(),HttpResponse.BodyHandlers.ofByteArray());
        check(result.statusCode()); return result.body();
    }
    private void put(String path, byte[] data) throws IOException, InterruptedException {
        var req = request(path).header("Content-Type","application/octet-stream")
            .PUT(HttpRequest.BodyPublishers.ofByteArray(data)).build();
        check(http.send(req,HttpResponse.BodyHandlers.discarding()).statusCode());
    }

    /** On interruption every unacknowledged PUT can be retried using the original ciphertext. */
    public void sync() throws IOException, InterruptedException, SQLException {
        while (true) {
            var pending = replica.pending();
            for (var row : pending) {
                var attachment = attachment(row);
                if (attachment != null) {
                    try { new EncryptedBlobTree(replica, this).upload(attachment); }
                    catch (java.security.GeneralSecurityException invalid) { throw new IOException("Invalid staged attachment", invalid); }
                }
                put("ops/" + row.id(),row.data());
                replica.acknowledge(row.id());
            }
            if (pending.size() < PacketJournal.PAGE_LIMIT) break;
        }
        while (true) {
            long after = replica.cursor();
            var rows = SyncReplica.JSON.readValue(get("ops?after=" + after + "&limit=" + PacketJournal.PAGE_LIMIT),
                PacketJournal.Packet[].class);
            if (rows.length == 0) break;
            for (var row : rows) {
                var blob = attachment(row);
                if (blob != null) {
                    try { new EncryptedBlobTree(replica, this).read(blob, OutputStream.nullOutputStream()); }
                    catch (java.security.GeneralSecurityException invalid) { throw new IOException("Invalid remote attachment", invalid); }
                }
            }
            try { replica.receive(after, List.of(rows)); }
            catch (ConcurrentModificationException concurrent) {
                if (replica.cursor() == after) throw concurrent;
                continue;
            }
            if (rows.length < PacketJournal.PAGE_LIMIT) break;
        }
    }

    private EncryptedBlobTree.Manifest attachment(PacketJournal.Packet row) throws IOException, SQLException {
        var op = replica.open(row.id(), row.data());
        return op.kind() == io.studyhub.domain.sync.StudyOp.Kind.DESKTOP_ATTEMPT ? DesktopAttemptPacket.decode(op).blob() : null;
    }

    /** Signals "ready" on subscription or a committed cursor when new data arrives. Reconnect by subscribing and pulling. */
    public CompletableFuture<WebSocket> subscribe(java.util.function.Consumer<String> notification) {
        String target = endpoint.resolve("events").toString().replaceFirst("^http","ws");
        return http.newWebSocketBuilder().connectTimeout(TIMEOUT).header("Authorization",authorization)
            .buildAsync(URI.create(target),new WebSocket.Listener() {
                private final StringBuilder frame = new StringBuilder();
                @Override public CompletionStage<?> onText(WebSocket socket, CharSequence text, boolean last) {
                    frame.append(text);
                    if (frame.length() > 64) { socket.abort(); return null; }
                    if (last) { notification.accept(frame.toString()); frame.setLength(0); }
                    socket.request(1); return null;
                }
            });
    }
    /** Retry a saved manifest from its first chunk: HEAD skips bytes previously committed. */
    public int uploadMissing(BlobStore spool, List<SyncReplica.Chunk> chunks) throws IOException, InterruptedException {
        int uploaded = 0;
        for (var chunk : chunks) {
            if (!chunk.sha256().matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid chunk digest");
            String path = "chunks/" + chunk.sha256();
            var r = http.send(request(path).method("HEAD",HttpRequest.BodyPublishers.noBody()).build(),
                HttpResponse.BodyHandlers.discarding());
            if (r.statusCode() == 200) continue;
            if (r.statusCode() != 404) check(r.statusCode());
            try (var in = spool.open(chunk.sha256())) { put(path,in.readAllBytes()); }
            uploaded++;
        }
        return uploaded;
    }
    public void download(List<SyncReplica.Chunk> chunks, OutputStream out)
        throws IOException, InterruptedException, java.security.GeneralSecurityException {
        for (var chunk : chunks) {
            if (!chunk.sha256().matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid chunk digest");
            out.write(replica.openChunk(chunk,get("chunks/" + chunk.sha256())));
        }
    }
    byte[] cacheChunk(BlobStore spool, SyncReplica.Chunk chunk)
            throws IOException, InterruptedException, java.security.GeneralSecurityException {
        byte[] sealed = get("chunks/" + chunk.sha256());
        byte[] plain = replica.openChunk(chunk, sealed);
        spool.put(new ByteArrayInputStream(sealed));
        return plain;
    }
}
