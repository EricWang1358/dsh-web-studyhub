package io.studyhub.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.ArrayList;
import java.util.List;
import java.util.NoSuchElementException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.UnaryOperator;
import static io.studyhub.ai.Workflow.*;

/** Each state transition is one atomic SQLite row change, including the remote receipt and its result. */
final class WorkflowStore implements AutoCloseable {
    private final ObjectMapper json;
    private final FileChannel ownerChannel;
    private final FileLock owner;
    private final Connection db;
    private final ReentrantLock lock = new ReentrantLock();
    private final java.util.concurrent.locks.Condition changed = lock.newCondition();
    private final java.util.SortedMap<String, ConsoleJob> live = new java.util.TreeMap<>();

    WorkflowStore(Path directory, ObjectMapper json) throws Exception {
        this.json = json;
        Path root = Files.createDirectories(directory).toRealPath();
        ownerChannel = FileChannel.open(root.resolve("engine.lock"), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
        try {
            owner = ownerChannel.tryLock();
            if (owner == null) throw new IllegalStateException("Another process owns this workflow engine");
            db = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("workflow.sqlite"));
            try (var sql = db.createStatement()) {
                int version;
                try (var row = sql.executeQuery("PRAGMA user_version")) { row.next(); version = row.getInt(1); }
                if (version != 0 && version != 1) throw new IllegalStateException("Unsupported workflow database version " + version);
                sql.execute("PRAGMA journal_mode=WAL");
                sql.execute("PRAGMA synchronous=FULL");
                sql.executeUpdate("CREATE TABLE IF NOT EXISTS workflow(id TEXT PRIMARY KEY, document TEXT NOT NULL)");
                if (version == 0) sql.execute("PRAGMA user_version=1");
                try (var rows = sql.executeQuery("SELECT document FROM workflow WHERE json_extract(document,'$.status') IN ('QUEUED','RUNNING','CANCELLING','PAUSED')")) {
                    while (rows.next()) index(json.readValue(rows.getString(1), Job.class));
                }
            } catch (Exception failure) {
                db.close();
                throw failure;
            }
        } catch (Exception failure) {
            ownerChannel.close();
            throw failure;
        }
    }

    Job insert(Job initial) {
        String id = initial.plan().request().id();
        lock.lock();
        try (var stmt = db.prepareStatement("INSERT INTO workflow VALUES (?, ?) ON CONFLICT(id) DO NOTHING")) {
            stmt.setString(1, id);
            stmt.setString(2, json.writeValueAsString(initial));
            stmt.executeUpdate();
            var actual = read(id);
            if (!actual.plan().request().equals(initial.plan().request())) {
                throw new IllegalArgumentException("Workflow id already belongs to a different request");
            }
            index(actual);
            return actual;
        } catch (IllegalArgumentException conflict) {
            throw conflict;
        } catch (Exception failure) {
            throw new IllegalStateException("Could not create workflow", failure);
        } finally { lock.unlock(); }
    }

    Job read(String id) {
        lock.lock();
        try (var stmt = db.prepareStatement("SELECT document FROM workflow WHERE id=?")) {
            stmt.setString(1, id);
            try (var row = stmt.executeQuery()) {
                if (!row.next()) throw new NoSuchElementException("Unknown workflow");
                return json.readValue(row.getString(1), Job.class);
            }
        } catch (NoSuchElementException missing) {
            throw missing;
        } catch (Exception failure) {
            throw new IllegalStateException("Could not read workflow", failure);
        } finally { lock.unlock(); }
    }

    List<String> ids() {
        lock.lock();
        try (var stmt = db.createStatement(); var rows = stmt.executeQuery("SELECT id FROM workflow ORDER BY rowid")) {
            var ids = new ArrayList<String>();
            while (rows.next()) ids.add(rows.getString(1));
            return ids;
        } catch (Exception failure) {
            throw new IllegalStateException("Could not list workflows", failure);
        } finally { lock.unlock(); }
    }

    Job mutate(String id, UnaryOperator<Job> transition) {
        lock.lock();
        try {
            var old = read(id);
            var next = transition.apply(old);
            if (next == old) return old;
            try (var stmt = db.prepareStatement("UPDATE workflow SET document=? WHERE id=?")) {
                stmt.setString(1, json.writeValueAsString(next));
                stmt.setString(2, id);
                stmt.executeUpdate();
                index(next);
                changed.signalAll();
                return next;
            } catch (Exception failure) { throw new IllegalStateException("Could not persist workflow", failure); }
        } finally { lock.unlock(); }
    }

    private void index(Job job) {
        var row = ConsoleJob.of(job);
        if (row.live()) live.put(row.id(), row);
        else live.remove(row.id());
    }

    List<ConsoleJob> live() {
        lock.lock();
        try { return List.copyOf(live.values()); }
        finally { lock.unlock(); }
    }

    View await(String id, long revision, long timeoutMillis) throws InterruptedException {
        long left = TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
        lock.lockInterruptibly();
        try {
            var job = read(id);
            while (job.revision() == revision && left > 0) {
                left = changed.awaitNanos(left);
                job = read(id);
            }
            return job.view();
        } finally { lock.unlock(); }
    }

    @Override
    public void close() throws Exception {
        lock.lock();
        try { db.close(); }
        finally {
            try { owner.release(); } finally { ownerChannel.close(); lock.unlock(); }
        }
    }
}
