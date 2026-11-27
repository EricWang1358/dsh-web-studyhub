package io.studyhub.gateway;

import io.studyhub.platform.spi.AppPaths;
import io.studyhub.retrieval.HybridIndex;
import io.studyhub.retrieval.MiniLmEncoder;
import jakarta.annotation.PreDestroy;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ConcurrentModificationException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/retrieval")
@ConditionalOnProperty("studyhub.retrieval.model-dir")
final class RetrievalApi {
    private final HybridIndex index;
    private final MiniLmEncoder encoder;
    private final int maxPageBytes;
    private final Semaphore workers;

    RetrievalApi(AppPaths paths, @Value("${studyhub.retrieval.model-dir}") Path model,
                 @Value("${studyhub.retrieval.max-page-bytes:262144}") int maxPageBytes,
                 @Value("${studyhub.retrieval.max-concurrent:2}") int concurrency,
                 @Value("${studyhub.retrieval.inference-threads:2}") int threads) throws IOException, SQLException {
        if (maxPageBytes < 1 || maxPageBytes >= Integer.MAX_VALUE) throw new IllegalArgumentException("Invalid max-page-bytes");
        if (concurrency < 1) throw new IllegalArgumentException("Invalid retrieval concurrency");
        this.workers = new Semaphore(concurrency);
        this.maxPageBytes = maxPageBytes;
        encoder = MiniLmEncoder.open(model, threads);
        try {
            index = new HybridIndex(paths.data().resolve("retrieval").resolve("pages.sqlite"), encoder);
        } catch (IOException | SQLException | RuntimeException failure) {
            encoder.close();
            throw failure;
        }
    }

    @PutMapping(value = "/source", consumes = "text/plain")
    Map<String, Boolean> index(@RequestParam String libraryId, @RequestParam String courseId,
                               @RequestParam String sourceId, HttpServletRequest request) throws IOException, SQLException {
        var scope = scope(libraryId, courseId);
        checkKey(sourceId);
        if (request.getContentLengthLong() > maxPageBytes) throw tooLarge();
        return runBounded(() -> put(scope, sourceId, request));
    }

    private Map<String, Boolean> put(HybridIndex.Scope scope, String sourceId, HttpServletRequest request) throws IOException, SQLException {
        byte[] bytes = request.getInputStream().readNBytes(maxPageBytes + 1);
        if (bytes.length > maxPageBytes) throw tooLarge();
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected UTF-8 page text");
        }
        if (text.isBlank()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Empty page");
        try {
            return Map.of("changed", index.put(scope, sourceId, text));
        } catch (ConcurrentModificationException changed) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "The source changed during indexing", changed);
        }
    }

    @DeleteMapping("/source")
    Map<String, Boolean> delete(@RequestParam String libraryId, @RequestParam String courseId,
                                @RequestParam String sourceId) throws SQLException {
        checkKey(sourceId);
        return Map.of("deleted", index.delete(scope(libraryId, courseId), sourceId));
    }

    @GetMapping("/search")
    List<HybridIndex.Hit> search(@RequestParam String libraryId, @RequestParam String courseId,
                                 @RequestParam String query, @RequestParam(defaultValue = "10") int limit) throws IOException, SQLException {
        if (query.isBlank() || query.length() > 2048 || limit < 1 || limit > 100) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a query of 1–2048 characters and a limit of 1–100");
        }
        var scope = scope(libraryId, courseId);
        return runBounded(() -> index.search(scope, query, limit));
    }

    @FunctionalInterface
    private interface SearchWork<T> { T run() throws IOException, SQLException; }

    private <T> T runBounded(SearchWork<T> work) throws IOException, SQLException {
        if (!workers.tryAcquire()) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Retrieval workers are busy");
        try { return work.run(); }
        finally { workers.release(); }
    }

    private static HybridIndex.Scope scope(String libraryId, String courseId) {
        checkKey(libraryId);
        checkKey(courseId);
        return new HybridIndex.Scope(libraryId, courseId);
    }

    private static void checkKey(String key) {
        if (key.isBlank() || key.length() > 512) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid retrieval key");
    }

    private ResponseStatusException tooLarge() {
        return new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE, "Page exceeds " + maxPageBytes + " bytes");
    }

    @PreDestroy
    void close() throws IOException, SQLException {
        try { index.close(); }
        finally { encoder.close(); }
    }
}
