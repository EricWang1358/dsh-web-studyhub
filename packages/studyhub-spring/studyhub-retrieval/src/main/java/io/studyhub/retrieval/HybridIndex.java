package io.studyhub.retrieval;

import com.github.jelmerk.hnswlib.core.DistanceFunctions;
import com.github.jelmerk.hnswlib.core.Item;
import com.github.jelmerk.hnswlib.core.hnsw.HnswIndex;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.*;
import java.util.*;
import java.util.concurrent.locks.ReentrantLock;

/** SQLite owns both postings and vectors. Each cached HNSW graph contains exactly one scope. */
public final class HybridIndex implements AutoCloseable {
    public record Scope(String libraryId, String courseId) {
        public Scope {
            requireKey(libraryId);
            requireKey(courseId);
        }
    }

    public record Hit(String sourceId, String text, double score, Integer lexicalRank, Integer vectorRank) { }

    private record Vector(String id, float[] vector) implements Item<String, float[]> {
        public int dimensions() { return vector.length; }
    }

    private record Graph(long revision, HnswIndex<String, float[], Vector, Float> index) { }

    private final SentenceEncoder encoder;
    private final Connection db;
    private final ReentrantLock lock = new ReentrantLock();
    private final Map<Scope, Graph> graphs = new LinkedHashMap<>(4, 0.75f, true);
    private static final int APP_ID = 0x53485234; // SHR4, private search index file
    private static final int MAX_GRAPHS = 4;

    public HybridIndex(Path database, SentenceEncoder encoder) throws IOException, SQLException {
        this.encoder = Objects.requireNonNull(encoder);
        Path file = database.toAbsolutePath().normalize();
        Files.createDirectories(file.getParent());
        db = DriverManager.getConnection("jdbc:sqlite:" + file.toUri());
        try {
            initialize();
        } catch (SQLException | RuntimeException failure) {
            db.close();
            throw failure;
        }
    }

    private void initialize() throws SQLException {
        try (Statement statement = db.createStatement()) {
            statement.execute("PRAGMA busy_timeout=10000");
            long appId = scalar("PRAGMA application_id"), version = scalar("PRAGMA user_version");
            boolean newFile = appId == 0 && version == 0 && scalar("SELECT count(*) FROM sqlite_master") == 0;
            if (!newFile && (appId != APP_ID || version != 1)) throw new SQLException("Unknown StudyHub search index format");
            statement.execute("PRAGMA journal_mode=WAL");
            statement.execute("BEGIN IMMEDIATE");
            try {
                statement.execute("""
                        CREATE TABLE IF NOT EXISTS pages (
                          id INTEGER PRIMARY KEY, library TEXT NOT NULL, course TEXT NOT NULL,
                          source TEXT NOT NULL, body TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL,
                          UNIQUE(library,course,source))
                        """);
                statement.execute("CREATE VIRTUAL TABLE IF NOT EXISTS postings USING fts5(terms)");
                statement.execute("CREATE TABLE IF NOT EXISTS revisions (library TEXT, course TEXT, value INTEGER, PRIMARY KEY(library,course))");
                statement.execute("""
                        CREATE TABLE IF NOT EXISTS source_versions (
                          library TEXT, course TEXT, source TEXT, value INTEGER, PRIMARY KEY(library,course,source))
                        """);
                statement.execute("PRAGMA application_id=" + APP_ID);
                statement.execute("PRAGMA user_version=1");
                statement.execute("COMMIT");
            } catch (SQLException failure) {
                statement.execute("ROLLBACK");
                throw failure;
            }
        }
    }

    private long scalar(String query) throws SQLException {
        try (Statement statement = db.createStatement(); ResultSet result = statement.executeQuery(query)) {
            return result.getLong(1);
        }
    }

    /** A repeated, identical index request reuses the stored embedding. */
    public boolean put(Scope scope, String sourceId, String text) throws IOException, SQLException {
        requireKey(sourceId);
        if (text == null || text.isBlank()) throw new IllegalArgumentException("Empty source text");
        long sourceVersion;
        lock.lock();
        try {
            sourceVersion = sourceVersion(scope, sourceId);
            if (matches(scope, sourceId, text)) return false;
        } finally { lock.unlock(); }

        float[] vector = checkedVector(encoder.encode(text));
        String terms = String.join(" ", Terms.split(text));
        lock.lock();
        try (Statement transaction = db.createStatement()) {
            transaction.execute("BEGIN IMMEDIATE");
            try {
                if (matches(scope, sourceId, text)) {
                    transaction.execute("COMMIT");
                    return false;
                }
                if (sourceVersion(scope, sourceId) != sourceVersion) {
                    throw new ConcurrentModificationException("Source changed while it was being embedded: " + sourceId);
                }
                try (var insert = db.prepareStatement("""
                        INSERT INTO pages(library,course,source,body,model,vector) VALUES(?,?,?,?,?,?)
                        ON CONFLICT(library,course,source) DO UPDATE SET body=excluded.body,model=excluded.model,vector=excluded.vector
                        RETURNING id
                        """)) {
                    bindScope(insert, scope);
                    insert.setString(3, sourceId);
                    insert.setString(4, text);
                    insert.setString(5, encoder.identity());
                    var bytes = ByteBuffer.allocate(Float.BYTES * vector.length).order(ByteOrder.LITTLE_ENDIAN);
                    bytes.asFloatBuffer().put(vector);
                    insert.setBytes(6, bytes.array());
                    long row;
                    try (var rows = insert.executeQuery()) { rows.next(); row = rows.getLong(1); }
                    try (var postings = db.prepareStatement("INSERT OR REPLACE INTO postings(rowid,terms) VALUES(?,?)")) {
                        postings.setLong(1, row);
                        postings.setString(2, terms);
                        postings.executeUpdate();
                    }
                }
                incrementRevision(scope);
                incrementSourceVersion(scope, sourceId);
                transaction.execute("COMMIT");
                return true;
            } catch (SQLException | RuntimeException failure) {
                transaction.execute("ROLLBACK");
                throw failure;
            }
        } finally { lock.unlock(); }
    }

    private boolean matches(Scope scope, String sourceId, String text) throws SQLException {
        try (var query = db.prepareStatement("SELECT 1 FROM pages WHERE library=? AND course=? AND source=? AND body=? AND model=?")) {
            bindScope(query, scope);
            query.setString(3, sourceId);
            query.setString(4, text);
            query.setString(5, encoder.identity());
            try (var rows = query.executeQuery()) { return rows.next(); }
        }
    }

    private long sourceVersion(Scope scope, String sourceId) throws SQLException {
        try (var statement = db.prepareStatement("SELECT value FROM source_versions WHERE library=? AND course=? AND source=?")) {
            bindScope(statement, scope);
            statement.setString(3, sourceId);
            try (var rows = statement.executeQuery()) { return rows.next() ? rows.getLong(1) : 0; }
        }
    }

    private void incrementSourceVersion(Scope scope, String sourceId) throws SQLException {
        try (var statement = db.prepareStatement("""
                INSERT INTO source_versions(library,course,source,value) VALUES(?,?,?,1)
                ON CONFLICT(library,course,source) DO UPDATE SET value=value+1
                """)) {
            bindScope(statement, scope);
            statement.setString(3, sourceId);
            statement.executeUpdate();
        }
    }

    public boolean delete(Scope scope, String sourceId) throws SQLException {
        requireKey(sourceId);
        lock.lock();
        try (var transaction = db.createStatement()) {
            transaction.execute("BEGIN IMMEDIATE");
            try (var remove = db.prepareStatement("DELETE FROM pages WHERE library=? AND course=? AND source=? RETURNING id");
                 var postings = db.prepareStatement("DELETE FROM postings WHERE rowid=?")) {
                bindScope(remove, scope);
                remove.setString(3, sourceId);
                boolean deleted;
                try (var rows = remove.executeQuery()) {
                    deleted = rows.next();
                    if (deleted) postings.setLong(1, rows.getLong(1));
                }
                if (deleted) {
                    postings.executeUpdate();
                    incrementRevision(scope);
                }
                // Fence an in-flight first embedding even when it has not produced a row yet.
                incrementSourceVersion(scope, sourceId);
                transaction.execute("COMMIT");
                return deleted;
            } catch (SQLException | RuntimeException failure) {
                transaction.execute("ROLLBACK");
                throw failure;
            }
        } finally { lock.unlock(); }
    }

    private void incrementRevision(Scope scope) throws SQLException {
        try (var statement = db.prepareStatement("""
                INSERT INTO revisions(library,course,value) VALUES(?,?,1)
                ON CONFLICT(library,course) DO UPDATE SET value=value+1
                """)) {
            bindScope(statement, scope);
            statement.executeUpdate();
        }
    }

    public List<Hit> search(Scope scope, String query, int limit) throws IOException, SQLException {
        Objects.requireNonNull(scope);
        if (limit < 1 || limit > 1000) throw new IllegalArgumentException("limit must be in [1,1000]");
        if (query == null || query.isBlank()) return List.of();
        float[] vector = checkedVector(encoder.encode(query));
        lock.lock();
        try (var transaction = db.createStatement()) {
            // The graph, lexical ranking and returned text all see the same WAL snapshot.
            transaction.execute("BEGIN");
            try {
                Map<String, Integer> lexical = lexical(scope, query, limit);
                var graph = graph(scope);
                Map<String, Integer> semantic = new HashMap<>();
                for (var result : graph.findNearest(vector, limit)) {
                    semantic.put(result.item().id(), semantic.size() + 1);
                }
                Set<String> sources = new HashSet<>(lexical.keySet());
                sources.addAll(semantic.keySet());
                var candidates = sources.stream().map(id -> new Hit(id, "", weight(lexical.get(id)) + weight(semantic.get(id)),
                        lexical.get(id), semantic.get(id))).sorted(Comparator.comparingDouble(Hit::score).reversed()
                        .thenComparing(Hit::sourceId)).limit(limit).toList();
                List<Hit> hits = new ArrayList<>();
                try (var find = db.prepareStatement("SELECT body FROM pages WHERE library=? AND course=? AND source=?")) {
                    bindScope(find, scope);
                    for (Hit candidate : candidates) {
                        find.setString(3, candidate.sourceId());
                        try (var rows = find.executeQuery()) {
                            if (!rows.next()) throw new SQLException("Vector posting without a matching scoped source");
                            hits.add(new Hit(candidate.sourceId(), rows.getString(1), candidate.score(),
                                    candidate.lexicalRank(), candidate.vectorRank()));
                        }
                    }
                }
                transaction.execute("COMMIT");
                return List.copyOf(hits);
            } catch (SQLException | RuntimeException failure) {
                transaction.execute("ROLLBACK");
                throw failure;
            }
        } finally { lock.unlock(); }
    }

    private static double weight(Integer rank) { return rank == null ? 0 : 1.0 / (60 + rank); }

    /** Lexical control for evaluating the embedding contribution on identical postings. */
    List<String> lexicalIds(Scope scope, String query, int limit) throws SQLException {
        lock.lock();
        try { return List.copyOf(lexical(scope, query, limit).keySet()); }
        finally { lock.unlock(); }
    }

    private Map<String, Integer> lexical(Scope scope, String query, int limit) throws SQLException {
        Map<String, Integer> ranks = new LinkedHashMap<>();
        String match = Terms.match(query);
        if (match.isBlank()) return ranks;
        try (var statement = db.prepareStatement("""
                SELECT pages.source FROM postings JOIN pages ON pages.id=postings.rowid
                WHERE pages.library=? AND pages.course=? AND postings MATCH ?
                ORDER BY bm25(postings),pages.source LIMIT ?
                """)) {
            bindScope(statement, scope);
            statement.setString(3, match);
            statement.setInt(4, limit);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) ranks.put(rows.getString(1), ranks.size() + 1);
            }
        }
        return ranks;
    }

    private HnswIndex<String, float[], Vector, Float> graph(Scope scope) throws SQLException {
        long revision;
        try (var statement = db.prepareStatement("SELECT value FROM revisions WHERE library=? AND course=?")) {
            bindScope(statement, scope);
            try (var rows = statement.executeQuery()) { revision = rows.next() ? rows.getLong(1) : 0; }
        }
        Graph cached = graphs.get(scope);
        if (cached != null && cached.revision() == revision) return cached.index();
        int size;
        try (var count = db.prepareStatement("SELECT count(*) FROM pages WHERE library=? AND course=? AND model=?")) {
            bindScope(count, scope);
            count.setString(3, encoder.identity());
            try (var rows = count.executeQuery()) { size = rows.getInt(1); }
        }
        HnswIndex<String, float[], Vector, Float> next = HnswIndex.newBuilder(encoder.dimensions(),
                DistanceFunctions.FLOAT_COSINE_DISTANCE, Math.max(size, 1)).withM(16).withEf(100).withEfConstruction(160).build();
        try (var query = db.prepareStatement("SELECT source,vector FROM pages WHERE library=? AND course=? AND model=? ORDER BY source")) {
            bindScope(query, scope);
            query.setString(3, encoder.identity());
            try (var rows = query.executeQuery()) {
                while (rows.next()) {
                    byte[] bytes = rows.getBytes(2);
                    if (bytes.length != encoder.dimensions() * Float.BYTES) throw new SQLException("Stored vector dimension mismatch");
                    float[] value = new float[encoder.dimensions()];
                    ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(value);
                    next.add(new Vector(rows.getString(1), value));
                }
            }
        }
        graphs.put(scope, new Graph(revision, next));
        if (graphs.size() > MAX_GRAPHS) graphs.remove(graphs.keySet().iterator().next());
        return next;
    }

    private float[] checkedVector(float[] vector) throws IOException {
        if (vector.length != encoder.dimensions()) throw new IOException("Encoder dimension mismatch");
        double norm = 0;
        for (float v : vector) norm += (double)v * v;
        if (!Double.isFinite(norm) || norm == 0) throw new IOException("Non-finite or empty embedding");
        return vector;
    }

    private static void bindScope(PreparedStatement statement, Scope scope) throws SQLException {
        statement.setString(1, scope.libraryId());
        statement.setString(2, scope.courseId());
    }

    private static void requireKey(String key) {
        if (key == null || key.isBlank()) throw new IllegalArgumentException("Empty retrieval key");
    }

    @Override public void close() throws SQLException {
        lock.lock();
        try {
            graphs.clear();
            db.close();
        } finally { lock.unlock(); }
    }
}
