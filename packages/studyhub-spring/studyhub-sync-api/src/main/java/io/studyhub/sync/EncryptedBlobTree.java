package io.studyhub.sync;

import io.studyhub.storage.BlobStore;
import java.io.*;
import java.nio.file.NoSuchFileException;
import java.security.*;
import java.util.*;

/** Authenticated content tree shared by full-library backups and individual desktop review revisions. */
final class EncryptedBlobTree {
    private static final int BLOCK = Packets.MAX_BYTES - 29;
    private static final int FANOUT = 128;
    public record Manifest(int format, long bytes, String sha256, int depth, SyncReplica.Chunk root) {
        public Manifest {
            if (format != 1 || bytes < 1 || !sha256.matches("[0-9a-f]{64}") || depth < 0 || depth > 8)
                throw new IllegalArgumentException("Invalid backup manifest");
        }
    }
    record Staged(Manifest manifest, List<SyncReplica.Chunk> chunks) {}
    private final SyncReplica replica;
    private final SyncPeer peer;
    final BlobStore spool;

    EncryptedBlobTree(SyncReplica replica, SyncPeer peer) throws IOException {
        this.replica = replica;
        this.peer = peer;
        var db = replica.journal.db.path();
        spool = new BlobStore(db.resolveSibling(db.getFileName() + ".sync-chunks"));
    }

    void read(Manifest manifest, OutputStream output) throws IOException, InterruptedException, GeneralSecurityException {
        var digest = MessageDigest.getInstance("SHA-256");
        var checked = new DigestOutputStream(output, digest);
        long bytes = restore(manifest.root(), manifest.depth(), manifest.bytes(), checked);
        if (bytes != manifest.bytes() || !HexFormat.of().formatHex(digest.digest()).equals(manifest.sha256()))
            throw new IOException("Attachment length or digest mismatch");
    }

    /** Upload children before making the referencing journal packet visible to another device. */
    void upload(Manifest manifest) throws IOException, InterruptedException, GeneralSecurityException {
        upload(manifest.root(), manifest.depth());
    }

    private void upload(SyncReplica.Chunk chunk, int depth) throws IOException, InterruptedException, GeneralSecurityException {
        if (depth != 0) {
            SyncReplica.Chunk[] children;
            try (var file = spool.open(chunk.sha256())) {
                children = SyncReplica.JSON.readValue(replica.openChunk(chunk, file.readAllBytes()), SyncReplica.Chunk[].class);
            }
            if (children.length < 1 || children.length > FANOUT) throw new IOException("Invalid staged attachment index");
            for (var child : children) upload(child, depth - 1);
        }
        peer.uploadMissing(spool, List.of(chunk));
    }
    Staged stage(InputStream source) throws IOException, GeneralSecurityException {
        List<SyncReplica.Chunk> layer = new ArrayList<>(), all = new ArrayList<>();
        long size = 0;
        var hash = MessageDigest.getInstance("SHA-256");
        try (var input = new DigestInputStream(source,hash)) {
            while (true) {
                byte[] block = input.readNBytes(BLOCK);
                if (block.length == 0) break;
                size += block.length; layer.add(replica.stageChunk(spool,block));
            }
        }
        if (size == 0) throw new IOException("Empty attachment");
        String digest = HexFormat.of().formatHex(hash.digest());
        all.addAll(layer);
        int depth = 0;
        while (layer.size() > 1) {
            List<SyncReplica.Chunk> parents = new ArrayList<>();
            for (int i = 0; i < layer.size(); i += FANOUT) {
                var children = layer.subList(i,Math.min(i+FANOUT,layer.size()));
                parents.add(replica.stageChunk(spool,SyncReplica.JSON.writeValueAsBytes(children)));
            }
            layer = parents; all.addAll(layer); depth++;
        }
        return new Staged(new Manifest(1,size,digest,depth,layer.getFirst()),List.copyOf(all));
    }

    private long restore(SyncReplica.Chunk chunk,int depth,long remaining,OutputStream out) throws IOException, InterruptedException, GeneralSecurityException {
        if (remaining < 1) throw new IOException("Excess backup chunks");
        byte[] data;
        try (var file = spool.open(chunk.sha256())) {
            data = replica.openChunk(chunk,file.readAllBytes());
        } catch (NoSuchFileException absent) {
            data = peer.cacheChunk(spool, chunk);
        }
        if (depth == 0) {
            if (data.length == 0 || data.length > remaining) throw new IOException("Invalid backup length");
            out.write(data); return data.length;
        }
        var children = SyncReplica.JSON.readValue(data,SyncReplica.Chunk[].class);
        if (children.length < 1 || children.length > FANOUT) throw new IOException("Invalid backup index");
        long bytes = 0;
        for (var child : children) bytes += restore(child,depth-1,remaining-bytes,out);
        return bytes;
    }
}
