package io.studyhub.sync;

import com.fasterxml.jackson.core.*;
import io.studyhub.domain.sync.StudyOp;
import io.studyhub.storage.*;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;

/** Transfers a complete Node export verbatim. Archives are separate immutable operations, so two exports never overwrite each other. */
public final class NodeBackup {
    private static final Set<String> REQUIRED = Set.of("sources","decks","drafts","attempts","runs");
    private record Stage(EncryptedBlobTree.Manifest manifest, List<SyncReplica.Chunk> chunks, UUID op) {}
    private final SyncReplica replica;
    private final SyncPeer peer;
    private final EncryptedBlobTree tree;

    public NodeBackup(SyncReplica replica, SyncPeer peer) throws IOException {
        this.replica = replica;
        this.peer = peer;
        this.tree = new EncryptedBlobTree(replica, peer);
    }

    /** Only a complete exported library is eligible. Stream through records without normalizing or dropping fields. */
    private static String inspect(Path source) throws Exception {
        var hash = MessageDigest.getInstance("SHA-256");
        try (var in = new DigestInputStream(Files.newInputStream(source),hash);
             var json = SyncReplica.JSON.getFactory().createParser(in)) {
            if (json.nextToken() != JsonToken.START_OBJECT) throw new IOException("Expected a Node library export");
            var found = new HashSet<String>();
            int version = 0;
            while (json.nextToken() == JsonToken.FIELD_NAME) {
                String field = json.currentName();
                JsonToken value = json.nextToken();
                if (field.equals("version") && value == JsonToken.VALUE_NUMBER_INT) version = json.getIntValue();
                if (field.equals("format")) throw new IOException("Expected a complete export, received a sharded manifest");
                if (REQUIRED.contains(field) && value == JsonToken.START_ARRAY) found.add(field);
                json.skipChildren();
            }
            if (!found.equals(REQUIRED) || version < 1 || version > 5 || json.nextToken() != null)
                throw new IOException("Unsupported or incomplete Node library export");
        }
        return HexFormat.of().formatHex(hash.digest());
    }

    public UUID upload(Path source) throws Exception {
        String hash = inspect(source);
        var storageKey = new StudyDatabase.Key(replica.vault.toString(),"node-backup-staging",hash);
        var db = replica.journal.db;
        var saved = db.get(storageKey);
        Stage stage;
        if (saved.isPresent()) stage = SyncReplica.JSON.readValue(saved.get().payload(),Stage.class);
        else {
            var staged = tree.stage(Files.newInputStream(source));
            if (!hash.equals(staged.manifest().sha256())) throw new IOException("Export changed while staging");
            stage = new Stage(staged.manifest(), staged.chunks(), UUID.randomUUID());
            try { db.save(storageKey,0,SyncReplica.JSON.writeValueAsBytes(stage)); }
            catch (ConcurrentModificationException raced) {
                stage = SyncReplica.JSON.readValue(db.get(storageKey).orElseThrow().payload(),Stage.class);
            }
        }
        peer.uploadMissing(tree.spool,stage.chunks);
        replica.record(stage.op,null,StudyOp.Kind.BACKUP,null,null,SyncReplica.JSON.writeValueAsString(stage.manifest));
        peer.sync();
        return stage.op;
    }
    public void download(UUID id, Path output) throws Exception {
        if (Files.exists(output)) throw new FileAlreadyExistsException(output.toString());
        peer.sync();
        var snapshot = replica.operations().stream().filter(o -> o.id().equals(id) && o.kind()==StudyOp.Kind.BACKUP)
            .findFirst().orElseThrow(() -> new IOException("Backup ID not found"));
        var manifest = SyncReplica.JSON.readValue(snapshot.value(),EncryptedBlobTree.Manifest.class);
        Path parent = output.toAbsolutePath().getParent().toRealPath();
        Path tmp = Files.createTempFile(parent,".studyhub-backup-",".tmp");
        try {
            try (var out = Files.newOutputStream(tmp)) {
                tree.read(manifest,out);
            }
            if (!manifest.sha256().equals(inspect(tmp))) throw new IOException("Backup checksum mismatch");
            Files.createLink(output.toAbsolutePath(),tmp);
        } finally { Files.deleteIfExists(tmp); }
    }
}
