package io.studyhub.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.studyhub.platform.spi.AppPaths;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.OutputStream;
import java.io.Writer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.event.ContextClosedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/** Owns the process running the canonical StudyHub actions during the Java migration. */
@Component
final class CompatibilityEngine {
    private final String node;
    private final String configuredEntry;
    private final Path dataDir;
    private final ObjectMapper json;
    private final String token = LoopbackSession.newToken();
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_1_1)
            .proxy(HttpClient.Builder.NO_PROXY)
            .connectTimeout(Duration.ofSeconds(5))
            .build();
    private Process process;
    private int port;

    CompatibilityEngine(@Value("${studyhub.node:node}") String node,
                        @Value("${studyhub.sidecar-entry:}") String configuredEntry,
                        AppPaths paths,
                        ObjectMapper json) {
        this.node = node;
        this.configuredEntry = configuredEntry;
        this.dataDir = paths.data().toAbsolutePath().normalize();
        this.json = json;
    }

    @PostConstruct
    void start() throws Exception {
        try {
            Path entry = entryPath().toRealPath();
            // An unwritable location must fail startup before Node can fall back to the user's Documents.
            Path home = Files.createDirectories(dataDir.resolve("home")).toRealPath();
            Path library = Files.createDirectories(dataDir.resolve("library")).toRealPath();
            ProcessBuilder builder = new ProcessBuilder(node, entry.toString());
            builder.environment().put("DSH_HOME", home.toString());
            builder.environment().put("STUDYHUB_LIBRARY", library.toString());
            builder.redirectError(ProcessBuilder.Redirect.INHERIT);
            process = builder.start();
            // The sidecar watches this pipe for EOF to terminate when its parent exits.
            Writer handshake = process.outputWriter(StandardCharsets.UTF_8);
            handshake.write(json.writeValueAsString(Map.of("token", token)) + "\n");
            handshake.flush();

            CompletableFuture<Integer> ready = new CompletableFuture<>();
            Process child = process;
            Thread.ofVirtual().name("studyhub-sidecar-stdout").start(() -> readPort(child, ready));
            port = ready.get(30, TimeUnit.SECONDS);
        } catch (Exception failure) {
            stop();
            throw failure;
        }
    }

    private Path entryPath() throws IOException {
        if (!configuredEntry.isBlank()) return Path.of(configuredEntry);
        Path cwd = Path.of("").toAbsolutePath();
        for (Path parent = cwd; parent != null; parent = parent.getParent()) {
            Path candidate = parent.resolve("packages/studyhub-desktop/entry/sidecar.mjs");
            if (Files.isRegularFile(candidate)) return candidate;
        }
        throw new IOException("StudyHub compatibility engine not found; configure studyhub.sidecar-entry");
    }

    ProcessBuilder committedHistoryReader(String module, Path root) throws IOException {
        var builder = new ProcessBuilder(node, "--input-type=module", "-e", module,
                entryPath().toRealPath().toString(), root.toString());
        builder.environment().keySet().removeIf(k -> !java.util.Set.of("PATH", "SYSTEMROOT", "WINDIR",
                "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "LANG", "LC_ALL")
                .contains(k.toUpperCase(java.util.Locale.ROOT)));
        return builder.redirectError(ProcessBuilder.Redirect.INHERIT);
    }

    private void readPort(Process child, CompletableFuture<Integer> ready) {
        try (BufferedReader output = child.inputReader(StandardCharsets.UTF_8)) {
            // A port is the only value trusted from stdout. Never interpret an upstream host or URL.
            StringBuilder line = new StringBuilder();
            int ch;
            while ((ch = output.read()) != -1 && ch != '\n' && line.length() < 4096) {
                line.append((char) ch);
            }
            if (ch != '\n') throw new IOException("Incomplete StudyHub sidecar handshake");
            var announced = json.readTree(line.toString()).path("port");
            if (!announced.isIntegralNumber() || !announced.canConvertToInt()
                    || announced.intValue() < 1 || announced.intValue() > 65535) {
                throw new IOException("Invalid StudyHub sidecar port");
            }
            ready.complete(announced.intValue());
            output.transferTo(Writer.nullWriter());
        } catch (Exception failure) {
            ready.completeExceptionally(failure);
        }
    }

    boolean available() {
        return process != null && process.isAlive();
    }

    HttpClient http() {
        return http;
    }

    HttpRequest.Builder request(String path) throws IOException {
        if (!available()) throw new IOException("StudyHub compatibility engine stopped");
        return HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .header(LoopbackSession.HEADER, token);
    }

    @PreDestroy
    @EventListener(ContextClosedEvent.class)
    void stop() {
        try {
            if (process != null) {
                try (OutputStream stdin = process.getOutputStream()) {
                    // EOF initiates the sidecar's own shutdown (watchers, jobs and SSE sessions).
                } finally {
                    if (!process.waitFor(3, TimeUnit.SECONDS)) {
                        process.destroyForcibly().waitFor(3, TimeUnit.SECONDS);
                    }
                }
            }
        } catch (IOException ignored) {
            // The process can exit and close its pipe before the Spring context stops.
        } catch (InterruptedException interrupted) {
            if (process != null) process.destroyForcibly();
            Thread.currentThread().interrupt();
        } finally {
            http.shutdownNow();
        }
    }
}
