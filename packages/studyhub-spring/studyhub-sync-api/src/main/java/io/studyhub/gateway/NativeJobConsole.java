package io.studyhub.gateway;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.studyhub.ai.Workflow.ConsoleJob;
import io.studyhub.ai.WorkflowService;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Set;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

/** Add active native workflows to the existing console without changing its React client or its Node-owned rows. */
@Component
@ConditionalOnProperty(name = "studyhub.ai.enabled", havingValue = "true")
final class NativeJobConsole {
    private static final String ID_PREFIX = "spring-workflow:";
    private static final String FINGERPRINT_PREFIX = "studyhub-spring/";
    private static final Set<String> ACTIONS = Set.of("snapshot", "job.live.list", "job.status", "job.cancel", "job.control");
    private final WorkflowService jobs;
    private final CompatibilityEngine engine;
    private final ObjectMapper json;
    private final JsonNode templates;

    NativeJobConsole(WorkflowService jobs, CompatibilityEngine engine, ObjectMapper json) throws IOException {
        this.jobs = jobs;
        this.engine = engine;
        this.json = json;
        try (var resource = getClass().getResourceAsStream("/META-INF/studyhub/console-contracts.json")) {
            if (resource == null) throw new IOException("Missing generated task console contracts");
            templates = json.readTree(resource);
        }
    }

    boolean handle(RpcBody input, String action, HttpServletResponse response) throws IOException {
        if (!ACTIONS.contains(action)) return false;
        byte[] bytes;
        try (var source = input.open()) { bytes = source.readAllBytes(); }
        JsonNode envelope = json.readTree(bytes);
        JsonNode args = envelope.path("args");
        String id = args.path("jobId").asText("");
        if (id.startsWith(ID_PREFIX) && !action.equals("snapshot") && !action.equals("job.live.list")) {
            local(action, id, args, response);
            return true;
        }
        if (action.equals("job.control") || (action.equals("job.status") && !id.isEmpty())) return false;
        if (action.equals("job.cancel") && (!args.path("all").asBoolean(false) || !id.isEmpty())) return false;

        List<ConsoleJob> live = jobs.liveJobs();
        String structural = structural(live);
        if (action.equals("snapshot") && args instanceof ObjectNode object && object.has("since")) {
            String since = object.path("since").asText("");
            String prefix = FINGERPRINT_PREFIX + structural + "/";
            if (since.startsWith(prefix)) object.put("since", since.substring(prefix.length()));
            else if (since.startsWith(FINGERPRINT_PREFIX) || !live.isEmpty()) object.remove("since");
            bytes = json.writeValueAsBytes(envelope);
        }
        var request = engine.request("/api/call").timeout(Duration.ofSeconds(200)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        HttpResponse<InputStream> upstream;
        try { upstream = engine.http().send(request, HttpResponse.BodyHandlers.ofInputStream()); }
        catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted waiting for task console", interrupted);
        }
        try (var source = upstream.body()) {
            response.setStatus(upstream.statusCode());
            response.setHeader("Cache-Control", "no-store");
            response.setContentType("application/json; charset=utf-8");
            if (upstream.statusCode() != 200) {
                source.transferTo(response.getOutputStream());
                return true;
            }
            // Snapshot payloads can contain large libraries. Stream each unrelated field untouched.
            try (var parser = json.createParser(source); var out = json.createGenerator(response.getOutputStream())) {
                if (parser.nextToken() != JsonToken.START_OBJECT) throw new IOException("Expected an RPC envelope");
                out.writeStartObject();
                while (parser.nextToken() == JsonToken.FIELD_NAME) {
                    String field = parser.currentName();
                    out.writeFieldName(field);
                    var value = parser.nextToken();
                    if (!field.equals("value") || value != JsonToken.START_OBJECT) out.copyCurrentStructure(parser);
                    else merge(parser, out, action, live, structural);
                }
                out.writeEndObject();
            }
        }
        return true;
    }

    private void merge(JsonParser parser, JsonGenerator out, String action, List<ConsoleJob> live, String structural) throws IOException {
        out.writeStartObject();
        while (parser.nextToken() == JsonToken.FIELD_NAME) {
            String name = parser.currentName();
            out.writeFieldName(name);
            JsonToken token = parser.nextToken();
            if (name.equals("jobs") && token == JsonToken.START_ARRAY) {
                out.writeStartArray();
                while (parser.nextToken() != JsonToken.END_ARRAY) out.copyCurrentStructure(parser);
                for (var item : live) {
                    if (action.equals("job.cancel")) {
                        jobs.cancel(item.id());
                        json.writeTree(out, row(jobs.consoleJob(item.id())));
                    } else json.writeTree(out, row(item));
                }
                out.writeEndArray();
            } else if (action.equals("snapshot") && name.equals("fingerprint") && token == JsonToken.VALUE_STRING && !live.isEmpty()) {
                out.writeString(FINGERPRINT_PREFIX + structural + "/" + parser.getText());
            } else out.copyCurrentStructure(parser);
        }
        out.writeEndObject();
    }

    private void local(String action, String externalId, JsonNode args, HttpServletResponse response) throws IOException {
        response.setContentType("application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        String id = externalId.substring(ID_PREFIX.length());
        try {
            var previous = jobs.consoleJob(id);
            String control = action.equals("job.cancel") ? "cancel" : args.path("action").asText("");
            Object result;
            if (action.equals("job.status")) {
                result = row(previous).put("finished", !previous.live());
            } else {
                if (action.equals("job.control") && !row(previous).path("contract").path("actions").path(control).path("available").asBoolean()) {
                    throw new IllegalStateException("This action is unavailable for the workflow");
                }
                if (control.equals("cancel")) jobs.cancel(id);
                else if (control.equals("resume")) jobs.resume(id);
                else throw new IllegalArgumentException("Unsupported workflow control");
                var current = row(jobs.consoleJob(id));
                result = action.equals("job.cancel") ? Map.of("jobs", List.of(current))
                        : Map.of("jobId", externalId, "action", control, "status", current.path("contract").path("status"));
            }
            json.writeValue(response.getOutputStream(), Map.of("ok", true, "value", result));
        } catch (NoSuchElementException | IllegalArgumentException | IllegalStateException refused) {
            json.writeValue(response.getOutputStream(), Map.of("ok", false, "error", refused.getMessage(), "code", "STUDY_ERROR"));
        }
    }

    private static String structural(List<ConsoleJob> live) {
        try {
            var digest = MessageDigest.getInstance("SHA-256");
            for (var job : live) digest.update((job.id() + "/" + job.status() + "\n").getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private ObjectNode row(ConsoleJob job) {
        String state = switch (job.status()) {
            case QUEUED -> "queued"; case RUNNING -> "running"; case CANCELLING -> "cancelling";
            case CANCELLED -> "cancelled"; case PAUSED -> "paused"; case RECONCILE -> "interrupted";
            case FAILED -> "failed"; case SUCCEEDED -> "complete";
        };
        String id = ID_PREFIX + job.id();
        ObjectNode contract = templates.path(state).deepCopy();
        contract.put("jobId", id);
        contract.put("title", job.title());
        contract.withObject("/detail").put("label", job.title());
        if (!job.stage().isBlank()) contract.withObject("/stage").put("text", job.stage());
        contract.withObject("/progress").put("done", job.done()).put("total", job.total())
                .put("percent", Math.round(100f * job.done() / job.total()));
        contract.withObject("/usage").put("tokens", job.tokens()).put("calls", job.answered());
        if (job.startedAt() > 0) contract.put("startedAt", Instant.ofEpochMilli(job.startedAt()).toString());
        var result = json.createObjectNode().put("id", id).put("type", "spring-workflow").put("label", job.title())
                .put("stage", job.stage()).put("status", state.equals("paused") ? "running" : state)
                .put("paused", state.equals("paused")).put("done", job.done()).put("total", job.total());
        result.set("contract", contract);
        return result;
    }
}
