package io.studyhub.gateway;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.studyhub.ai.Workflow;
import io.studyhub.ai.WorkflowService;
import java.io.IOException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import static io.studyhub.gateway.ReviewedDraftJournal.*;

/** Coordinates the immutable model output with the Node bank's versioned draft, plan and atomic publish mutation. */
@Service
final class ReviewedDraftPublisher {
    private final ReviewedDraftJournal journal;
    private final ObjectProvider<WorkflowService> services;
    private final CompatibilityEngine engine;
    private final ObjectMapper json;
    private final LibraryAccess access;

    ReviewedDraftPublisher(ReviewedDraftJournal journal, ObjectProvider<WorkflowService> services, CompatibilityEngine engine,
                           ObjectMapper json, LibraryAccess access) {
        this.access = access;
        this.journal = journal;
        this.services = services;
        this.engine = engine;
        this.json = json;
    }

    private WorkflowService jobs() {
        var jobs = services.getIfAvailable();
        if (jobs == null) throw new IllegalStateException("Enable the native workflow engine to verify this review");
        return jobs;
    }

    Map<String,String> start(Command command) throws Exception {
        return access.reviewed(() -> reserve(command));
    }

    private Map<String,String> reserve(Command command) throws Exception {
        if (command.id() == null || !command.id().matches("[a-zA-Z0-9_-]{1,96}") || command.title() == null
                || command.title().isBlank() || command.sourceId() == null || command.sourceId().isBlank())
            throw new IllegalArgumentException("A stable request id, title and sourceId are required");
        var service = jobs();
        String library = root();
        String source = source(command.sourceId());
        var row = journal.reserve(library, command, source);
        service.start(new Workflow.Request(row.jobId(), source, command.topics(), command.author(), command.reviewer(), command.fallback(), true));
        return Map.of("draftId", row.draftId(), "jobId", row.jobId());
    }

    private String root() throws Exception {
        return rpc("library.revision", Map.of()).required("root").asText();
    }

    private String source(String id) throws Exception {
        var page = rpc("source.get", Map.of("id", id, "limit", 60000));
        String text = page.required("text").asText();
        if (text.length() != page.required("chars").asInt())
            throw new IllegalArgumentException("Select an individual source of at most 60000 characters for this workflow");
        return text;
    }

    private Entry scoped(String id) throws Exception {
        var row = journal.read(id);
        if (!row.library().equals(root())) throw new IllegalStateException("This draft belongs to another library");
        return row;
    }

    JsonNode prepare(String id) throws Exception {
        return access.reviewed(() -> prepareDraft(id));
    }

    private JsonNode prepareDraft(String id) throws Exception {
        var row = scoped(id);
        if (row.receipt() != null) return row.prepared();
        var current = lookup("draft.get", id);
        if (row.prepared() != null) {
            if (current == null || !current.equals(row.prepared()))
                throw new IllegalStateException("The prepared draft was edited, removed or published");
            return current;
        }
        var view = jobs().status(row.jobId());
        if (view.status() != Workflow.Status.SUCCEEDED) throw new IllegalStateException("Review is pending or incomplete");
        if (!source(row.command().sourceId()).equals(row.source())) throw new IllegalStateException("The reviewed source has changed");
        var expected = generated(row, view);
        if (current == null) {
            if (lookup("deck.get", id) != null) throw new IllegalStateException("The reserved deck id is already in use");
            current = rpc("draft.save", Map.of("deck", expected));
        } else {
            // An interrupted save may have reached the Node bank before the journal acquired its snapshot.
            var content = (ObjectNode) current.deepCopy();
            content.remove(List.of("quality", "createdAt", "draftVersion"));
            if (current.path("draftVersion").asInt() != 1 || !content.equals(expected))
                throw new IllegalStateException("A different draft already occupies the reserved id");
        }
        journal.write(new Entry(id, row.jobId(), row.library(), row.command(), row.source(), current, null, null, null));
        return current;
    }

    private ObjectNode generated(Entry row, Workflow.View view) throws IOException {
        var deck = json.createObjectNode().put("id", row.draftId()).put("title", row.command().title());
        var review = view.stages().getLast();
        deck.putObject("editorial").putObject("nativeReview").put("workflowId", row.jobId())
                .put("revision", view.revision()).put("reviewReceipt", review.receipt())
                .put("approved", json.readTree(review.result()).required("approved").booleanValue());
        var cards = deck.putArray("cards");
        for (int index = 0; index < view.stages().size() - 1; index++) {
            var stage = view.stages().get(index);
            var fields = json.readTree(stage.result());
            var card = cards.addObject().put("id", stage.receipt()).put("kind", "flashcard")
                    .put("topic", row.command().topics().get(index)).put("prompt", fields.required("question").asText());
            for (String field : List.of("answer", "objective", "hint", "explanation", "misconception"))
                card.set(field, fields.required(field));
            card.putArray("citations").addObject().put("sourceId", row.command().sourceId()).set("quote", fields.required("quote"));
        }
        return deck;
    }

    static boolean handles(RpcBody.Routing route) {
        String action = route.action();
        String id = action.equals("draft.save") ? route.deckId() : route.id();
        return id.startsWith(PREFIX) && id.substring(PREFIX.length()).matches("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")
                && (action.equals("draft.save") || action.equals("draft.publish")
                || action.equals("draft.publish.plan") || action.equals("draft.publish.start") || action.equals("draft.publish.quick"));
    }

    JsonNode route(String action, JsonNode args) throws Exception {
        return access.reviewed(() -> routeDraft(action, args));
    }

    private JsonNode routeDraft(String action, JsonNode args) throws Exception {
        if (action.equals("draft.save")) {
            var deck = args.required("deck");
            var row = scoped(deck.required("id").asText());
            // The editor saves before publishing, including unchanged drafts. Preserve the version for an exact no-op.
            if (row.prepared() != null && row.prepared().equals(deck) && deck.equals(lookup("draft.get", row.draftId()))) return deck;
            return rpc(action, args);
        }
        return publishDraft(args.required("id").asText(), action, args);
    }

    JsonNode publish(String id, String action, JsonNode args) throws Exception {
        return access.reviewed(() -> publishDraft(id, action, args));
    }

    private JsonNode publishDraft(String id, String action, JsonNode args) throws Exception {
        var row = scoped(id);
        if (args.hasNonNull("mergeTargetId") || args.hasNonNull("targetId"))
            throw new IllegalStateException("A reviewed draft publishes into its own reserved deck");
        if (row.prepared() != null && args.has("draftVersion") && !row.prepared().path("draftVersion").equals(args.path("draftVersion")))
            throw new IllegalStateException("The supplied draft version differs from the version reviewed");
        if (action.equals("draft.publish.start") && row.background() != null) return row.background();
        if (row.receipt() != null) return row.receipt();
        if (row.prepared() == null) {
            prepareDraft(id);
            row = journal.read(id);
        }
        var prepared = row.prepared();
        var review = prepared.required("editorial").required("nativeReview");
        if (!review.required("approved").booleanValue()) throw new IllegalStateException("The independent reviewer rejected this draft");
        if (args.has("draftVersion") && !prepared.path("draftVersion").equals(args.path("draftVersion")))
            throw new IllegalStateException("The supplied draft version differs from the version reviewed");
        var current = lookup("draft.get", id);
        if (current == null && row.intent() != null) {
            var published = lookup("deck.get", id);
            if (matchesPublished(prepared, published)) return finish(row, row.intent().required("expect").required("receipt"));
        }
        if (!prepared.equals(current)) throw new IllegalStateException("Draft content or version changed after review");
        if (!source(row.command().sourceId()).equals(row.source())) throw new IllegalStateException("The reviewed source has changed");
        if (lookup("deck.get", id) != null) throw new IllegalStateException("The reserved deck id is already in use");

        var checked = json.createObjectNode().put("id", id);
        checked.set("draftVersion", prepared.required("draftVersion"));
        var plan = rpc("draft.publish.plan", checked);
        var expected = plan.required("expect").required("receipt");
        if (!expected.path("deckId").asText("").equals(id) || expected.path("accepted").asInt() != prepared.path("cards").size()
                || expected.path("rejected").asInt() != 0) throw new IllegalStateException("Canonical deck validation rejected the draft: " + plan.path("decision").path("rejectedIssues"));
        if (action.equals("draft.publish.plan")) return plan;
        row = journal.write(new Entry(id, row.jobId(), row.library(), row.command(), row.source(), prepared, plan, null, row.background()));
        if (action.equals("draft.publish.start")) {
            var job = rpc(action, checked);
            journal.write(new Entry(id, row.jobId(), row.library(), row.command(), row.source(), prepared, plan, null, job));
            return job;
        }
        // Use only the decision produced by Node on this exact version. Client-supplied overrides are never forwarded.
        var write = checked.deepCopy().put("planned", true);
        write.set("publishDecision", plan.required("decision"));
        return finish(row, rpc("draft.publish", write));
    }

    private boolean matchesPublished(JsonNode prepared, JsonNode deck) {
        if (deck == null || !deck.path("editorial").path("nativeReview").equals(prepared.path("editorial").path("nativeReview"))
                || !deck.path("title").equals(prepared.path("title")) || deck.path("cards").size() != prepared.path("cards").size()) return false;
        for (int i = 0; i < prepared.path("cards").size(); i++) {
            var expected = prepared.path("cards").get(i);
            var actual = deck.path("cards").get(i);
            var fields = expected.fields();
            while (fields.hasNext()) {
                var field = fields.next();
                if (!field.getValue().equals(actual.path(field.getKey()))) return false;
            }
        }
        return true;
    }

    private JsonNode finish(Entry row, JsonNode receipt) throws Exception {
        journal.write(new Entry(row.draftId(), row.jobId(), row.library(), row.command(), row.source(),
                row.prepared(), row.intent(), receipt, row.background()));
        return receipt;
    }

    private JsonNode lookup(String action, String id) throws Exception {
        var answer = send(action, Map.of("id", id));
        if (!answer.path("ok").asBoolean() && answer.path("code").asText().equalsIgnoreCase("not-found")) return null;
        return value(answer);
    }

    private JsonNode rpc(String action, Object args) throws Exception { return value(send(action, args)); }
    private JsonNode value(JsonNode answer) {
        if (!answer.path("ok").asBoolean()) throw new IllegalStateException(answer.path("error").asText("StudyHub bank operation failed"));
        return answer.required("value");
    }
    private JsonNode send(String action, Object args) throws Exception {
        var req = engine.request("/api/call").timeout(Duration.ofSeconds(200)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(json.writeValueAsBytes(Map.of("action", action, "args", args)))).build();
        var response = engine.http().send(req, HttpResponse.BodyHandlers.ofInputStream());
        try (var body = response.body()) {
            if (response.statusCode() != 200) throw new IOException("StudyHub bank returned HTTP " + response.statusCode());
            return json.readTree(body);
        }
    }
}
