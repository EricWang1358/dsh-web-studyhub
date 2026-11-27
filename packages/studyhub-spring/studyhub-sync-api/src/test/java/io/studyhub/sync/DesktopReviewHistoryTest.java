package io.studyhub.sync;

import io.studyhub.storage.StudyDatabase;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Clock;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class DesktopReviewHistoryTest {
    @TempDir Path root;

    @Test void committedStateAndReceiptAdvanceTogetherAcrossRestarts() throws Exception {
        var vault = UUID.randomUUID();
        var key = Packets.key(new byte[32]);
        var path = root.resolve("mirror.sqlite");
        var a = "{\"attempt\":{\"id\":\"123\",\"quiz_id\":\"c\",\"grade\":1,\"extra\":1.23570},\"course\":null,\"deck\":\"math\"}";
        var b = a.replace("\"grade\":1", "\"grade\":4,\"gradeOriginal\":1");
        UUID initial, corrected, largeId;
        String large = a.replace("1.23570", "\"" + "学习".repeat(70000) + "\"");
        try (var db = StudyDatabase.open(path)) {
            var replica = new SyncReplica(db, vault, "local", key, Clock.systemUTC());
            var peer = new SyncPeer(replica, URI.create("http://127.0.0.1:1"), "unused");
            var history = new DesktopReviewHistory(replica, peer, "math");
            history.bindSource(root, "1:42");
            assertTrue(history.capture(a));
            assertFalse(history.capture(a));
            assertTrue(history.capture(b));
            assertTrue(history.capture(large));
            var entries = history.page(0, 64).entries();
            assertEquals(3, entries.size());
            initial = entries.get(0).revision(); corrected = entries.get(1).revision(); largeId = entries.get(2).revision();
            assertNull(entries.get(0).previous());
            assertEquals(initial, entries.get(1).previous());
            assertEquals(corrected, entries.get(2).previous());
            assertEquals(large, read(history, largeId));
            var other = new DesktopReviewHistory(replica, peer, "chemistry");
            assertTrue(other.page(0,64).entries().isEmpty());
            assertThrows(NoSuchElementException.class, () -> read(other, largeId));
        }
        try (var db = StudyDatabase.open(path)) {
            var replica = new SyncReplica(db, vault, "local", key, Clock.systemUTC());
            var history = new DesktopReviewHistory(replica, new SyncPeer(replica, URI.create("http://127.0.0.1:1"), "unused"), "math");
            history.bindSource(root, "1:42");
            assertThrows(IllegalStateException.class, () -> history.bindSource(root, "1:43"));
            assertFalse(history.capture(large));
            assertEquals(a, read(history, initial));
            assertEquals(b, read(history, corrected));
            assertTrue(history.capture(a)); // an explicit restore can return to an earlier value
            assertEquals(largeId, history.page(3, 64).entries().getFirst().previous());
        }
    }

    private static String read(DesktopReviewHistory history, UUID revision) throws Exception {
        var result = new ByteArrayOutputStream();
        history.read(revision, result);
        return result.toString(StandardCharsets.UTF_8);
    }
}
