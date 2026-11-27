package io.studyhub.storage;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.io.*;
import java.nio.file.*;
import java.sql.SQLException;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class StorageTest {
    @TempDir Path temp;

    void node(String mode, Path file) throws Exception {
        var child = new ProcessBuilder("node", Path.of("src/test/resources/sqlite-peer.mjs").toRealPath().toString(),
            mode, file.toString(), temp.toString()).inheritIO().start();
        try {
            assertTrue(child.waitFor(45, TimeUnit.SECONDS));
            assertEquals(0, child.exitValue());
        } finally { child.destroyForcibly(); child.waitFor(); }
    }

    @Test void nodeAndJavaExchangeActualSqliteAndRestoreAnExistingNodeExport() throws Exception {
        var file = temp.resolve("记忆 storage #1.sqlite");
        try (var db = StudyDatabase.open(file)) {
            assertEquals(file.toRealPath(), db.path());
            node("write", file);
            var imported = db.get(new StudyDatabase.Key("L1","exports","book")).orElseThrow();
            assertArrayEquals(Files.readAllBytes(temp.resolve("from-node.json")), imported.payload());
            db.save(new StudyDatabase.Key("L1","exports","restored"), 0, imported.payload());
            assertTrue(db.get(new StudyDatabase.Key("L2","exports","book")).isEmpty());
            node("restore", file);
        }
    }

    @Test void futureAndForeignFilesRemainByteIdenticalOnRejection() throws Exception {
        var file = temp.resolve("schema.sqlite");
        try (var open = StudyDatabase.open(file)) {
            node("future", file);
            assertThrows(SQLException.class, () -> open.save(new StudyDatabase.Key("a","b","c"), 0, new byte[1]));
        }
        for (String name : List.of("schema.sqlite","foreign.sqlite")) {
            var existing = temp.resolve(name);
            if (name.equals("foreign.sqlite")) node("foreign", existing);
            var original = Files.readAllBytes(existing);
            assertThrows(SQLException.class, () -> StudyDatabase.open(existing));
            assertArrayEquals(original, Files.readAllBytes(existing));
        }
    }

    @Test void readersAndTwoIndependentWritersRespectVersionsAndTransactions() throws Exception {
        var file = temp.resolve("concurrency.sqlite");
        try (var first = StudyDatabase.open(file); var second = StudyDatabase.open(file);
             var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<?>> jobs = new ArrayList<>();
            for (int n = 0; n < 200; n++) {
                int id = n;
                jobs.add(workers.submit(() -> {
                    var key = new StudyDatabase.Key("L","cards","C"+id);
                    var store = id % 2 == 0 ? first : second;
                    store.save(key, 0, new byte[]{1});
                    assertEquals(1, first.get(key).orElseThrow().version());
                    store.save(key, 1, new byte[]{2});
                    assertThrows(ConcurrentModificationException.class, () -> store.save(key, 1, new byte[]{3}));
                    assertArrayEquals(new byte[]{2}, second.get(key).orElseThrow().payload());
                    return null;
                }));
            }
            for (var job : jobs) job.get(45, TimeUnit.SECONDS);
            assertThrows(SQLException.class, () -> first.read(c -> c.createStatement().executeUpdate("DELETE FROM study_records")));
            assertThrows(SQLException.class, () -> first.write(c -> {
                try (var s = c.createStatement()) { s.executeUpdate("DELETE FROM study_records"); }
                throw new SQLException("forced rollback");
            }));
            assertTrue(second.get(new StudyDatabase.Key("L","cards","C9")).isPresent());
        }
    }

    @Test void concurrentFirstOpenMigratesOnce() throws Exception {
        var file = temp.resolve("bootstrap.sqlite");
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            var go = new CountDownLatch(1);
            var futures = new ArrayList<Future<?>>();
            for (int i = 0; i < 6; i++) futures.add(workers.submit(() -> {
                go.await();
                try (var db = StudyDatabase.open(file)) { assertEquals(file.toRealPath(),db.path()); }
                return null;
            }));
            go.countDown();
            for (var f : futures) f.get(45,TimeUnit.SECONDS);
        }
    }

    @Test void concurrentBlobWritersDeduplicateAndCleanFailedUploads() throws Exception {
        var directory = temp.resolve("blobs");
        var store = new BlobStore(directory);
        var payload = new byte[64 * 1024 + 13];
        new Random(42).nextBytes(payload);
        String hash;
        try (var workers = Executors.newVirtualThreadPerTaskExecutor()) {
            List<Future<String>> refs = new ArrayList<>();
            for (int i = 0; i < 20; i++) refs.add(workers.submit(() -> store.put(new ByteArrayInputStream(payload))));
            hash = refs.getFirst().get();
            for (var ref : refs) assertEquals(hash, ref.get());
        }
        try (var in = store.open(hash)) { assertArrayEquals(payload, in.readAllBytes()); }
        assertThrows(IOException.class, () -> store.put(new InputStream() {
            @Override public int read() throws IOException { throw new IOException("incomplete"); }
        }));
        try (var files = Files.list(directory)) { assertEquals(1, files.count()); }
        assertThrows(IllegalArgumentException.class, () -> store.open("../secret"));
    }
}
