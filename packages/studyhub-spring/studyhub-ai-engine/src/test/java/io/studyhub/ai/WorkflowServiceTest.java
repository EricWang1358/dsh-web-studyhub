package io.studyhub.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.tomakehurst.wiremock.WireMockServer;
import com.github.tomakehurst.wiremock.client.MappingBuilder;
import com.github.tomakehurst.wiremock.extension.Parameters;
import com.github.tomakehurst.wiremock.extension.ServeEventListener;
import com.github.tomakehurst.wiremock.stubbing.ServeEvent;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import io.opentelemetry.sdk.OpenTelemetrySdk;
import io.opentelemetry.sdk.trace.SdkTracerProvider;
import io.opentelemetry.sdk.trace.export.SimpleSpanProcessor;
import io.opentelemetry.sdk.testing.exporter.InMemorySpanExporter;
import java.nio.file.Path;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Predicate;
import jdk.jfr.Recording;
import jdk.jfr.consumer.RecordingFile;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static com.github.tomakehurst.wiremock.core.WireMockConfiguration.wireMockConfig;
import static org.junit.jupiter.api.Assertions.*;
import static io.studyhub.ai.Workflow.*;

class WorkflowServiceTest {
    @TempDir Path root;
    final ObjectMapper json = new ObjectMapper();
    final SimpleMeterRegistry metrics = new SimpleMeterRegistry();
    final CountDownLatch received = new CountDownLatch(1);
    WireMockServer wire;
    WorkflowSettings settings;
    WorkflowService service;
    static final String CARD = "{\"question\":\"Which color?\",\"answer\":\"Blue\"}";
    static final String REVIEW = "{\"approved\":true,\"feedback\":\"Matches the source\"}";

    @BeforeEach void setup() throws Exception {
        wire = new WireMockServer(wireMockConfig().dynamicPort().extensions(new ServeEventListener() {
            public String getName() { return "signal-request"; }
            public void afterMatch(ServeEvent event, Parameters parameters) { received.countDown(); }
        }));
        wire.start();
        settings = new WorkflowSettings(Map.of(
                "author", new Provider("one", "author-model", wire.baseUrl(), "TEST_KEY", true),
                "reviewer", new Provider("two", "reviewer-model", wire.baseUrl(), "", true),
                "offline", new Provider("three", "offline-model", wire.baseUrl(), "", false)),
                2, 60, 90000, 90000, 96, 4, 4096, 15);
        service = open();
    }
    WorkflowService open() throws Exception {
        return new WorkflowService(root, settings, json, metrics, key -> "unit-secret");
    }
    @AfterEach void stop() throws Exception {
        try { if (service != null) service.close(); } finally { wire.stop(); }
    }
    Request request(String id, String fallback, String... topics) {
        return new Request(id, "Source text about blue.", List.of(topics), "author", "reviewer", fallback);
    }
    MappingBuilder forModel(String model) {
        return post(urlEqualTo("/v1/chat/completions")).withRequestBody(matchingJsonPath("$.model", equalTo(model + "-model")));
    }
    String body(String content) throws Exception {
        return json.writeValueAsString(Map.of("id", "completion", "model", "wire", "object", "chat.completion",
                "choices", List.of(Map.of("index", 0, "finish_reason", "stop", "message", Map.of("role", "assistant", "content", content))),
                "usage", Map.of("prompt_tokens", 8, "completion_tokens", 4, "total_tokens", 12,
                        "prompt_tokens_details", Map.of("cached_tokens", 3))));
    }
    void model(String model, String content) throws Exception {
        wire.stubFor(forModel(model).willReturn(okJson(body(content))));
    }
    View waitFor(String id, Predicate<View> condition) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(20).toNanos();
        View view = service.status(id);
        while (!condition.test(view)) {
            long left = deadline - System.nanoTime();
            assertTrue(left > 0, "Unexpected terminal state or timeout: " + view);
            view = service.await(id, view.revision(), Math.max(1, TimeUnit.NANOSECONDS.toMillis(left)));
        }
        return view;
    }
    View terminal(String id) throws Exception {
        return waitFor(id, v -> v.status() != Status.RUNNING && v.status() != Status.QUEUED && v.status() != Status.CANCELLING);
    }

    @Test void independentAuthorsThenReviewerSharePrefixAndRetainReceiptsOnReplay() throws Exception {
        model("author", CARD); model("reviewer", REVIEW);
        Request request = request("job", null, "shade", "color");
        service.start(request);
        var done = terminal("job");
        assertEquals(Status.SUCCEEDED, done.status(), done.toString());
        assertEquals(List.of(CARD, CARD, REVIEW), done.stages().stream().map(Stage::result).toList());
        assertEquals(36L, done.stages().stream().mapToLong(Stage::tokens).sum());
        assertEquals(6, metrics.get("studyhub.ai.cached.tokens").tag("provider", "author").counter().count());
        var requests = wire.findAll(postRequestedFor(urlEqualTo("/v1/chat/completions"))
                .withRequestBody(matchingJsonPath("$.model", equalTo("author-model")))
                .withRequestBody(matchingJsonPath("$.response_format.json_schema.strict", equalTo("true")))
                .withHeader("Authorization", equalTo("Bearer unit-secret")));
        assertEquals(2, requests.size());
        var prefixes = requests.stream().map(r -> {
            try { return json.readTree(r.getBodyAsString()).at("/messages/0/content").asText(); }
            catch (Exception ex) { throw new AssertionError(ex); }
        }).distinct().toList();
        assertEquals(1, prefixes.size());
        service.close(); service = open();
        assertEquals(done, service.start(request));
        assertThrows(IllegalArgumentException.class, () -> service.start(request("job", null, "changed")));
        wire.verify(3, postRequestedFor(anyUrl()));
    }

    @Test void known429RetriesSameReceiptThenUsesOnlyDeclaredFallback() throws Exception {
        wire.stubFor(forModel("author").willReturn(aResponse().withStatus(429).withBody("rate limited")));
        model("offline", CARD); model("reviewer", REVIEW);
        service.start(request("limited", "offline", "color"));
        var done = terminal("limited");
        assertEquals(Status.SUCCEEDED, done.status(), done.toString());
        String receipt = done.stages().getFirst().receipt();
        assertEquals("offline", done.stages().getFirst().provider());
        wire.verify(2, postRequestedFor(anyUrl()).withHeader("Idempotency-Key", equalTo(receipt))
                .withRequestBody(matchingJsonPath("$.model", equalTo("author-model"))));
        wire.verify(1, postRequestedFor(anyUrl()).withHeader("Idempotency-Key", equalTo(receipt))
                .withRequestBody(matchingJsonPath("$.response_format.type", equalTo("json_object"))));
    }

    @Test void serverFailureIsAmbiguousAndReconciliationContinuesFromSavedProviderOutput() throws Exception {
        wire.stubFor(forModel("author").willReturn(aResponse().withStatus(503)));
        model("reviewer", REVIEW);
        service.start(request("uncertain", "offline", "color"));
        var interrupted = terminal("uncertain");
        assertEquals(Status.RECONCILE, interrupted.status(), interrupted.toString());
        var step = interrupted.stages().getFirst();
        service.close(); service = open();
        assertThrows(IllegalStateException.class, () -> service.resume("uncertain"));
        assertThrows(ProviderRouter.Failure.class, () -> service.reconcile("uncertain", step.receipt(), "{}", 12));
        service.reconcile("uncertain", step.receipt(), CARD, 12);
        service.resume("uncertain");
        assertEquals(Status.SUCCEEDED, terminal("uncertain").status());
        wire.verify(2, postRequestedFor(anyUrl()));
    }

    @Test void crashAfterPersistedIntentCannotReissuePotentiallyPaidStep() throws Exception {
        // Materialize the exact committed row at the crash boundary, before a response or journal update.
        var req = request("crash", null, "color");
        var plan = new Plan(req, settings.provider("author"), settings.provider("reviewer"), null, 96, 90000);
        var intent = new Stage("author-0", "known-receipt", StepState.PENDING, "", null, 0, 0, 0, 0, "").intent("author", 1200);
        var review = new Stage("review", "review-receipt", StepState.PENDING, "", null, 0, 0, 0, 0, "");
        service.close();
        try (var c = DriverManager.getConnection("jdbc:sqlite:" + root.resolve("workflow.sqlite"));
             var s = c.prepareStatement("INSERT INTO workflow VALUES (?,?)")) {
            s.setString(1, req.id()); s.setString(2, json.writeValueAsString(new Job(plan, Status.RUNNING, List.of(intent, review), 2, "")));
            s.executeUpdate();
        }
        service = open();
        assertEquals(Status.RECONCILE, service.status("crash").status());
        assertEquals("known-receipt", service.status("crash").stages().getFirst().receipt());
        wire.verify(0, postRequestedFor(anyUrl()));
    }

    @Test void cancellationInterruptsActualProviderWaitAndKeepsAmbiguousReceipt() throws Exception {
        wire.stubFor(forModel("author").willReturn(okJson(body(CARD)).withFixedDelay(12000)));
        try (Recording capture = new Recording()) {
            capture.enable("jdk.VirtualThreadPinned").withThreshold(Duration.ofMillis(250)).withStackTrace();
            capture.start();
            service.start(request("stop", null, "color"));
            assertTrue(received.await(10, TimeUnit.SECONDS));
            assertEquals(Status.CANCELLING, service.cancel("stop").status());
            var cancelled = assertTimeoutPreemptively(Duration.ofSeconds(6), () -> terminal("stop"));
            assertEquals(Status.CANCELLED, cancelled.status());
            assertEquals(StepState.UNKNOWN, cancelled.stages().getFirst().state());
            capture.stop();
            var path = root.resolve("cancellation.jfr");
            capture.dump(path);
            var pinned = RecordingFile.readAllEvents(path).stream()
                    .filter(e -> e.getEventType().getName().equals("jdk.VirtualThreadPinned"))
                    .filter(e -> e.getStackTrace() != null && e.getStackTrace().getFrames().stream()
                            .anyMatch(frame -> frame.getMethod().getType().getName().startsWith("io.studyhub.ai."))).toList();
            assertTrue(pinned.isEmpty(), pinned.toString());
        }
    }

    @Test void badOutputAndPermanentClientErrorsDoNotTriggerFallback() throws Exception {
        model("author", "{\"question\":1,\"answer\":\"bad\"}");
        service.start(request("invalid", "offline", "color"));
        var invalid = terminal("invalid");
        assertEquals(Status.FAILED, invalid.status());
        assertEquals(12, invalid.stages().getFirst().tokens());
        wire.stubFor(forModel("author").willReturn(aResponse().withStatus(401)));
        service.start(request("auth", "offline", "color"));
        assertEquals(Status.FAILED, terminal("auth").status());
        wire.verify(2, postRequestedFor(anyUrl()));
    }

    @Test void lostConnectionAfterRequestDoesNotResubmitToAnotherProvider() throws Exception {
        wire.stubFor(forModel("author").willReturn(aResponse()
                .withFault(com.github.tomakehurst.wiremock.http.Fault.EMPTY_RESPONSE)));
        service.start(request("lost", "offline", "color"));
        var lost = terminal("lost");
        assertEquals(Status.RECONCILE, lost.status(), lost.toString());
        assertTrue(lost.stages().getFirst().reserved() > 0);
        wire.verify(1, postRequestedFor(anyUrl()));
    }

    @Test void budgetAndModelFamilyAreCheckedBeforeAnyRemoteCost() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> service.start(
                new Request("same-family", "Text", List.of("topic"), "author", "author", null)));
        service.close();
        settings = new WorkflowSettings(settings.providers(), 1, 5, 90000, 8, 96, 4, 4096, 15);
        service = open();
        service.start(request("over-budget", null, "topic"));
        var stopped = terminal("over-budget");
        assertEquals(Status.FAILED, stopped.status());
        assertEquals(0, stopped.stages().getFirst().reserved());
        wire.verify(0, postRequestedFor(anyUrl()));
    }

    @Test void tracesFollowParallelAuthorAndReviewCallsWithoutRecordingSourceOrCredentials() throws Exception {
        service.close();
        var exporter = InMemorySpanExporter.create();
        var provider = SdkTracerProvider.builder().addSpanProcessor(SimpleSpanProcessor.create(exporter)).build();
        try (var telemetry = OpenTelemetrySdk.builder().setTracerProvider(provider).build()) {
            service = new WorkflowService(root, settings, json, metrics, key -> "never-log-me", telemetry);
            model("author", CARD); model("reviewer", REVIEW);
            service.start(request("trace", null, "a", "b"));
            assertEquals(Status.SUCCEEDED, terminal("trace").status());
            service.close();
            var spans = exporter.getFinishedSpanItems();
            assertEquals(7, spans.size());
            assertEquals(1, spans.stream().map(s -> s.getTraceId()).distinct().count());
            assertEquals(3, spans.stream().filter(s -> s.getName().equals("studyhub.ai.call")).count());
            assertTrue(spans.stream().noneMatch(s -> s.getAttributes().toString().contains("Source text")
                    || s.getAttributes().toString().contains("never-log-me")));
        }
    }
}
