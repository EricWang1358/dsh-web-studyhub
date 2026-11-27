package io.studyhub.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.studyhub.storage.StudyDatabase;
import io.studyhub.sync.*;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Capture and delivery have independent lifetimes: an unreachable relay cannot block local capture. */
@Component
@ConditionalOnProperty(name = "studyhub.desktop-history.enabled", havingValue = "true")
final class DesktopHistorySync {
    private final StudyDatabase db;
    private final SyncPeer peer;
    final DesktopReviewHistory history;
    private final ProcessBuilder sourceCommand;
    private final Path sourceRoot;
    private final ObjectMapper json;
    private final long interval;
    private volatile boolean closing;
    private volatile Process source;
    private BufferedReader input;
    private BufferedWriter commands;
    private Thread captureWorker;
    private Thread deliveryWorker;
    private volatile Activity capture = new Activity(null, null);
    private volatile Activity transfer = new Activity(null, null);
    record Activity(Instant lastSuccess, String error) {}
    record Status(Activity capture, Activity relay) {}

    DesktopHistorySync(CompatibilityEngine engine, ObjectMapper json,
            @Value("${studyhub.desktop-history.root}") Path root,
            @Value("${studyhub.desktop-history.library}") String library,
            @Value("${studyhub.desktop-history.interval-ms:5000}") long interval,
            @Value("${STUDYHUB_SYNC_DB}") Path database,
            @Value("${STUDYHUB_SYNC_DEVICE}") String device,
            @Value("${STUDYHUB_SYNC_VAULT}") UUID vault,
            @Value("${STUDYHUB_SYNC_KEY}") String key,
            @Value("${STUDYHUB_SYNC_URL}") URI endpoint,
            @Value("${STUDYHUB_SYNC_TOKEN}") String token) throws Exception {
        if (interval < 250 || interval > 3600000) throw new IllegalArgumentException("Invalid desktop sync interval");
        if (token.length() < 32) throw new IllegalArgumentException("Invalid relay token");
        this.json = json;
        this.interval = interval;
        sourceRoot = root.toRealPath();
        try (var file = getClass().getResourceAsStream("desktop-history-source.mjs")) {
            if (file == null) throw new IOException("Missing desktop history reader");
            this.sourceCommand = engine.committedHistoryReader(new String(file.readAllBytes(), StandardCharsets.UTF_8), sourceRoot);
        }
        db = StudyDatabase.open(database);
        try {
            var replica = new SyncReplica(db, vault, device, Packets.key(Base64.getDecoder().decode(key)), Clock.systemUTC());
            peer = new SyncPeer(replica, endpoint, token);
            history = new DesktopReviewHistory(replica, peer, library);
        } catch (Exception failure) { db.close(); throw failure; }
    }

    @PostConstruct void start() {
        captureWorker = Thread.ofVirtual().name("studyhub-desktop-review-capture").start(() -> loop(true));
        deliveryWorker = Thread.ofVirtual().name("studyhub-desktop-review-sync").start(() -> loop(false));
    }

    private void loop(boolean local) {
        while (!closing) {
            try {
                if (local) scan(); else peer.sync();
                if (local) capture = new Activity(Instant.now(), null);
                else transfer = new Activity(Instant.now(), null);
            } catch (InterruptedException stopped) {
                Thread.currentThread().interrupt();
                return;
            } catch (Exception failure) {
                if (local) {
                    capture = new Activity(capture.lastSuccess(), failure.getClass().getSimpleName());
                    stopSource();
                } else transfer = new Activity(transfer.lastSuccess(), failure.getClass().getSimpleName());
            }
            try { Thread.sleep(interval); }
            catch (InterruptedException stopped) { Thread.currentThread().interrupt(); return; }
        }
    }

    private void scan() throws Exception {
        if (source == null) {
            source = sourceCommand.start();
            input = source.inputReader(StandardCharsets.UTF_8);
            commands = source.outputWriter(StandardCharsets.UTF_8);
            send("identity");
            String identity = input.readLine();
            if (identity == null) throw new EOFException("Committed history reader stopped");
            history.bindSource(sourceRoot, json.readTree(identity).path("identity").asText());
        }
        send("scan");
        String raw;
        while (!closing && (raw = input.readLine()) != null) {
            // The owned reader emits the original attempt first; inspect only the tag before passing its exact bytes on.
            try (var tag = json.createParser(raw)) {
                if (tag.nextToken() == com.fasterxml.jackson.core.JsonToken.START_OBJECT
                        && tag.nextToken() == com.fasterxml.jackson.core.JsonToken.FIELD_NAME
                        && "attempt".equals(tag.currentName())) {
                    history.capture(raw);
                    continue;
                }
            }
            JsonNode reply = json.readTree(raw);
            if (reply.has("error")) throw new IOException("Committed library is unreadable");
            if (reply.path("done").asBoolean(false)) { send("ack"); return; }
            throw new IOException("Unknown committed history frame");
        }
        throw new EOFException("Committed history reader stopped");
    }

    private void send(String command) throws IOException {
        commands.write(command);
        commands.newLine();
        commands.flush();
    }

    Status status() { return new Status(capture, transfer); }

    private void stopSource() {
        var reader = source;
        if (reader != null) reader.destroyForcibly();
        source = null;
    }

    @PreDestroy void close() throws InterruptedException {
        closing = true;
        stopSource();
        if (deliveryWorker != null) deliveryWorker.interrupt();
        if (captureWorker != null) {
            captureWorker.interrupt();
            captureWorker.join();
        }
        stopSource();
        if (deliveryWorker != null) deliveryWorker.join();
        db.close();
    }
}
