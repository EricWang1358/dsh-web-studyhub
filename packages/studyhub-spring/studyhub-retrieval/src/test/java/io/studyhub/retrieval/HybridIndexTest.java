package io.studyhub.retrieval;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.List;
import java.util.ConcurrentModificationException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.*;

class HybridIndexTest {
    private static final HybridIndex.Scope BIO = new HybridIndex.Scope("库-a", "biology");

    private static class TestEncoder implements SentenceEncoder {
        int calls;
        @Override public String identity() { return "test-3"; }
        @Override public int dimensions() { return 3; }
        @Override public float[] encode(String text) throws IOException {
            calls++;
            if (text.equals("bad")) throw new IOException("Offline");
            if (text.contains("enzyme") || text.contains("蛋白")) return new float[]{1, 0, 0};
            if (text.contains("cell")) return new float[]{0, 1, 0};
            return new float[]{0, 0, 1};
        }
    }

    @Test void exactScopeBeforeBothRankersAndAcrossRestarts(@TempDir Path temporary) throws Exception {
        Path file = temporary.resolve("index 数据库.sqlite");
        var otherCourse = new HybridIndex.Scope("库-a", "history");
        var otherLibrary = new HybridIndex.Scope("库-b", "biology");
        var encoder = new TestEncoder();
        try (var index = new HybridIndex(file, encoder)) {
            index.put(BIO, "shared", "蛋白质催化化学反应");
            index.put(BIO, "unique", "Translation in a cell");
            assertFalse(index.put(BIO, "unique", "Translation in a cell"));
            assertEquals(2, encoder.calls);
            index.put(otherCourse, "shared", "enzyme foreign course");
            for (int i = 0; i < 250; i++) index.put(otherLibrary, "p" + i, "enzyme foreign library");
            var crossLanguage = index.search(BIO, "enzyme", 1).getFirst();
            assertEquals("shared", crossLanguage.sourceId());
            assertNull(crossLanguage.lexicalRank());
            assertEquals(1, crossLanguage.vectorRank());
            var cjk = index.search(BIO, "蛋白", 1).getFirst();
            assertEquals(1, cjk.lexicalRank());
            assertEquals(2.0 / 61, cjk.score());
            assertEquals(2, index.search(BIO, "enzyme", 10).size());
            assertThrows(IOException.class, () -> index.put(BIO, "shared", "bad"));
            assertEquals("蛋白质催化化学反应", index.search(BIO, "enzyme", 1).getFirst().text());
            assertTrue(index.search(new HybridIndex.Scope("empty", "biology"), "enzyme", 10).isEmpty());
        }
        try (var first = new HybridIndex(file, encoder); var second = new HybridIndex(file, encoder)) {
            assertEquals("shared", first.search(BIO, "enzyme", 1).getFirst().sourceId());
            assertTrue(second.put(BIO, "shared", "cell membrane"));
            var replaced = first.search(BIO, "蛋白", 5);
            assertTrue(replaced.stream().allMatch(hit -> hit.lexicalRank() == null), "Obsolete FTS postings");
            assertTrue(second.delete(BIO, "shared"));
            assertFalse(second.delete(BIO, "shared"));
            assertEquals(List.of("unique"), first.search(BIO, "enzyme", 10).stream().map(HybridIndex.Hit::sourceId).toList());
            assertEquals("enzyme foreign course", first.search(otherCourse, "enzyme", 1).getFirst().text());
        }
    }

    @Test void foreignDatabaseIsUntouched(@TempDir Path temporary) throws Exception {
        Path foreign = temporary.resolve("unrelated.sqlite");
        try (var connection = DriverManager.getConnection("jdbc:sqlite:" + foreign); var stmt = connection.createStatement()) {
            stmt.execute("CREATE TABLE user_notes(body TEXT)");
        }
        byte[] previous = Files.readAllBytes(foreign);
        assertThrows(SQLException.class, () -> new HybridIndex(foreign, new TestEncoder()));
        assertArrayEquals(previous, Files.readAllBytes(foreign));
    }

    @Test void deleteFencesAnInFlightFirstEmbedding(@TempDir Path temporary) throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var slow = new TestEncoder() {
            @Override public float[] encode(String text) throws IOException {
                entered.countDown();
                try {
                    if (!release.await(10, TimeUnit.SECONDS)) throw new IOException("Test latch timed out");
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                    throw new IOException(stopped);
                }
                return super.encode(text);
            }
        };
        Path file = temporary.resolve("scoped.sqlite");
        try (var original = new HybridIndex(file, slow); var newer = new HybridIndex(file, new TestEncoder());
             var worker = Executors.newVirtualThreadPerTaskExecutor()) {
            var pending = worker.submit(() -> original.put(BIO, "fresh", "older first embedding"));
            try {
                assertTrue(entered.await(10, TimeUnit.SECONDS));
                assertFalse(newer.delete(BIO, "fresh"), "No posting had been committed yet");
            } finally { release.countDown(); }
            assertInstanceOf(ConcurrentModificationException.class, assertThrows(ExecutionException.class, pending::get).getCause());
            assertTrue(newer.search(BIO, "older", 10).isEmpty());
        }
    }

    @Test void checksumFailurePreventsNativeLoad(@TempDir Path temporary) throws Exception {
        Files.createDirectories(temporary.resolve("onnx"));
        Files.writeString(temporary.resolve("onnx/model_quantized.onnx"), "broken");
        assertThrows(IOException.class, () -> MiniLmEncoder.open(temporary));
    }
}
