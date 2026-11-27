package io.studyhub.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.studyhub.contracts.TransportLimits;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;

import java.io.InputStream;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
final class GatewayController {
    private final LoopbackSession session;
    private final LocalRequestFilter guard;
    private final CompatibilityEngine engine;
    private final ObjectMapper json;
    private final NativeJobConsole console;
    private final ReviewedDraftPublisher publisher;
    private final LibraryAccess access;

    GatewayController(LoopbackSession session, LocalRequestFilter guard, CompatibilityEngine engine, ObjectMapper json,
                      org.springframework.beans.factory.ObjectProvider<NativeJobConsole> console, ReviewedDraftPublisher publisher,
                      LibraryAccess access) {
        this.access = access;
        this.publisher = publisher;
        this.session = session;
        this.guard = guard;
        this.engine = engine;
        this.json = json;
        this.console = console.getIfAvailable();
    }

    @GetMapping(value = {"/", "/index.html"}, produces = "text/html;charset=UTF-8")
    ResponseEntity<String> index() {
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body("""
                <!doctype html>
                <html lang="zh-CN"><head><meta charset="utf-8">
                <meta name="viewport" content="width=device-width,initial-scale=1">
                <title>StudyHub</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/app.css">
                </head><body style="margin:0"><div id="root" style="height:100dvh"></div>
                <script>window.STUDY_TOKEN="%s";</script><script src="/app.js"></script></body></html>
                """.formatted(session.browserToken()));
    }

    @GetMapping("/favicon.ico")
    ResponseEntity<Void> favicon() {
        return ResponseEntity.noContent().build();
    }

    @GetMapping("/health")
    ResponseEntity<Map<String, Boolean>> health() {
        boolean up = engine.available();
        return ResponseEntity.status(up ? 200 : 503).cacheControl(CacheControl.noStore()).body(Map.of("ok", up));
    }

    @PostMapping("/api/call")
    void call(HttpServletRequest request, HttpServletResponse response) throws IOException {
        if (!guard.authorize(request, response)) return;
        String type = request.getContentType();
        if (type == null || !type.split(";", 2)[0].trim().equalsIgnoreCase("application/json")) {
            error(response, 415, "Expected application/json", "unsupported-media-type");
            return;
        }
        long size = request.getContentLengthLong();
        if (size > TransportLimits.MAX_RESTORE_REQUEST_BYTES) {
            response.setHeader("Connection", "close");
            error(response, 413, "Request body too large", "payload-too-large");
            return;
        }
        try (var incoming = new RpcBody()) {
            incoming.read(request.getInputStream());
            if (incoming.size() > TransportLimits.MAX_RESTORE_REQUEST_BYTES) {
                response.setHeader("Connection", "close");
                error(response, 413, "Request body too large", "payload-too-large");
                return;
            }
            RpcBody.Routing routing;
            try { routing = incoming.routing(); }
            catch (IOException invalid) {
                error(response, 400, "Invalid JSON", "invalid-json");
                return;
            }
            String action = routing.action();
            if (incoming.size() > TransportLimits.MAX_REQUEST_BYTES && !action.equals("restore")) {
                response.setHeader("Connection", "close");
                error(response, 413, "Request body too large", "payload-too-large");
                return;
            }
            if (ReviewedDraftPublisher.handles(routing)) {
                try (var data = incoming.open()) {
                    var args = json.readTree(data).path("args");
                    response.setContentType("application/json; charset=utf-8");
                    response.setHeader("Cache-Control", "no-store");
                    try {
                        var value = publisher.route(action, args);
                        json.writeValue(response.getOutputStream(), Map.of("ok", true, "value", value));
                    } catch (IllegalStateException | IllegalArgumentException refused) {
                        error(response, 200, refused.getMessage(), "STUDY_ERROR");
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        throw new IOException(interrupted);
                    } catch (Exception failure) {
                        throw new IOException(failure);
                    }
                    return;
                }
            }
            var shared = access.ordinary();
            shared.lock();
            try {
                if (console != null && console.handle(incoming, action, response)) return;
                try (var content = incoming.open()) {
                    var body = incoming.size() == 0 ? HttpRequest.BodyPublishers.noBody() :
                            HttpRequest.BodyPublishers.fromPublisher(HttpRequest.BodyPublishers.ofInputStream(() -> content), incoming.size());
                    var upstream = engine.request("/api/call").timeout(Duration.ofSeconds(200))
                            .header("Content-Type", type).POST(body).build();
                    relay(upstream, response, false);
                }
            } finally { shared.unlock(); }
        } catch (IOException failure) {
            unavailable(response);
        }
    }

    @GetMapping("/api/events")
    void events(HttpServletRequest request, HttpServletResponse response) throws IOException {
        if (!guard.authorize(request, response)) return;
        try {
            relay(engine.request("/api/events").header("Accept", "text/event-stream").GET().build(), response, true);
        } catch (IOException failure) {
            unavailable(response);
        }
    }

    private void relay(HttpRequest request, HttpServletResponse response, boolean events) throws IOException {
        HttpResponse<InputStream> upstream;
        try {
            upstream = engine.http().send(request, HttpResponse.BodyHandlers.ofInputStream());
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted waiting for StudyHub", interrupted);
        }
        try (InputStream input = upstream.body()) {
            response.setStatus(upstream.statusCode());
            response.setHeader("Cache-Control", "no-store");
            upstream.headers().firstValue("Content-Type").ifPresent(response::setContentType);
            if (!events || upstream.statusCode() != 200) {
                input.transferTo(response.getOutputStream());
                return;
            }
            response.setHeader("X-Accel-Buffering", "no");
            var output = response.getOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                output.flush();
            }
        }
    }

    private void unavailable(HttpServletResponse response) throws IOException {
        if (!response.isCommitted()) {
            response.resetBuffer();
            error(response, 503, "StudyHub engine unavailable", "engine-unavailable");
        }
    }

    private void error(HttpServletResponse response, int status, String message, String code) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        json.writeValue(response.getOutputStream(), Map.of("ok", false, "error", message, "code", code));
    }
}
