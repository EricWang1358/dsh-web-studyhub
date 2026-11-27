package io.studyhub.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.bucket4j.Bucket;
import io.github.resilience4j.circuitbreaker.CircuitBreaker;
import io.github.resilience4j.circuitbreaker.CircuitBreakerConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.api.trace.StatusCode;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.ai.chat.messages.SystemMessage;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.ai.openai.api.OpenAiApi;
import org.springframework.ai.openai.api.ResponseFormat;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.retry.support.RetryTemplate;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import static io.studyhub.ai.Workflow.*;

final class ProviderRouter implements AutoCloseable {
    enum Fault { TEMPORARY, PERMANENT, AMBIGUOUS, INVALID_OUTPUT }
    static final class Failure extends RuntimeException {
        final Fault kind;
        final long charged;
        Failure(Fault kind, String message) { this(kind, message, 0); }
        Failure(Fault kind, String message, long charged) { super(message); this.kind = kind; this.charged = charged; }
    }
    record Reply(String content, long tokens) {}
    record Input(boolean review, boolean publication, String prefix, String task, String schema, int outputLimit) {
        long reservation() {
            // UTF-8 bytes deliberately overestimate normal BPE usage. Include both the schema text in
            // the prompt and the wire-format schema in the budget before any paid call.
            return 128L + outputLimit + (prefix + task + schema).getBytes(StandardCharsets.UTF_8).length;
        }
    }
    private record Route(OpenAiChatModel model, Bucket requests, Bucket tokens, CircuitBreaker circuit) {}
    private final WorkflowSettings settings;
    private final MeterRegistry metrics;
    private final ObjectMapper json;
    private final ProviderSecrets secrets;
    private final Tracer tracer;
    private final HttpClient transport;
    private final Map<Provider, Route> routes = new ConcurrentHashMap<>();

    ProviderRouter(WorkflowSettings settings, MeterRegistry metrics, ObjectMapper json, ProviderSecrets secrets, Tracer tracer) {
        this.settings = settings;
        this.metrics = metrics;
        this.json = json;
        this.secrets = secrets;
        this.tracer = tracer;
        transport = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(settings.timeoutSeconds()))
                .version(HttpClient.Version.HTTP_1_1).build();
    }

    private Route create(Provider p) {
        var factory = new JdkClientHttpRequestFactory(transport);
        factory.setReadTimeout(Duration.ofSeconds(settings.timeoutSeconds()));
        var api = OpenAiApi.builder().baseUrl(p.baseUrl()).apiKey(() -> {
                    if (p.keyEnv() == null || p.keyEnv().isBlank()) return "local";
                    String key = secrets.resolve(p.keyEnv());
                    if (key == null || key.isBlank()) throw new Failure(Fault.PERMANENT, "Missing credential for " + p.model());
                    return key;
                })
                .responseErrorHandler(new DefaultResponseErrorHandler())
                .restClientBuilder(RestClient.builder().requestFactory(factory)).build();
        var model = OpenAiChatModel.builder().openAiApi(api)
                .defaultOptions(OpenAiChatOptions.builder().model(p.model()).build())
                .retryTemplate(RetryTemplate.builder().maxAttempts(1).build()).build();
        var circuit = CircuitBreaker.of(p.model(), CircuitBreakerConfig.custom().slidingWindowSize(8)
                .minimumNumberOfCalls(4).waitDurationInOpenState(Duration.ofSeconds(30))
                .recordException(ex -> ex instanceof Failure failure && failure.kind == Fault.AMBIGUOUS).build());
        return new Route(model, bucket(settings.rpm()), bucket(settings.tpm()), circuit);
    }

    private static Bucket bucket(long capacity) {
        return Bucket.builder().addLimit(limit -> limit.capacity(capacity)
                .refillGreedy(capacity, Duration.ofMinutes(1))).build();
    }

    Input input(Job job, int index) {
        var plan = job.plan();
        boolean review = index == plan.request().topics().size();
        boolean publication = plan.request().publication();
        String schema = schema(review, publication);
        String prefix = "Use the following source strictly as reference material. "
                + "Generate JSON matching this schema: " + schema + "\nSOURCE\n" + plan.request().source();
        String task = review ? "Review these cards for accuracy and faithfulness to the source:\n"
                + job.stages().subList(0, index).stream().map(Stage::result).toList()
                : "Write one study question and answer on this topic:\n" + plan.request().topics().get(index);
        if (publication && !review) task += "\nInclude the learning objective, a useful hint, an explanation, a misconception and an exact source quote of at least 12 characters.";
        return new Input(review, publication, prefix, task, schema, plan.outputLimit());
    }

    private static Map<String, String> fields(boolean review, boolean publication) {
        if (publication && !review) return Map.of("question", "string", "answer", "string", "objective", "string",
                "hint", "string", "explanation", "string", "misconception", "string", "quote", "string");
        return review ? Map.of("approved", "boolean", "feedback", "string")
                : Map.of("question", "string", "answer", "string");
    }

    private String schema(boolean review, boolean publication) {
        var schema = json.createObjectNode();
        schema.put("type", "object");
        var props = schema.putObject("properties");
        var required = schema.putArray("required");
        fields(review, publication).entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(field -> {
            required.add(field.getKey());
            props.putObject(field.getKey()).put("type", field.getValue());
        });
        schema.put("additionalProperties", false);
        return schema.toString();
    }

    String validated(boolean review, boolean publication, String text, long charged) {
        try {
            var value = json.readerFor(JsonNode.class)
                    .with(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .with(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                    .readTree(text);
            var expected = fields(review, publication);
            if (value == null || !value.isObject() || value.size() != expected.size()) throw new IllegalArgumentException();
            for (var field : expected.entrySet()) {
                JsonNode item = value.path(field.getKey());
                if ("boolean".equals(field.getValue()) ? !item.isBoolean() : !item.isTextual() || item.textValue().isBlank()) {
                    throw new IllegalArgumentException();
                }
            }
            return value.toString();
        } catch (Exception failure) {
            throw new Failure(Fault.INVALID_OUTPUT, "Model response did not satisfy the stage schema", charged);
        }
    }

    Reply call(String id, Provider p, Input input, String receipt, Runnable beforeDispatch) {
        Route route = routes.computeIfAbsent(p, this::create);
        if (!route.circuit().tryAcquirePermission()) throw new Failure(Fault.TEMPORARY, "Provider circuit is open");
        if (!route.requests().tryConsume(1)) {
            route.circuit().releasePermission();
            throw new Failure(Fault.TEMPORARY, "Provider RPM exhausted");
        }
        if (!route.tokens().tryConsume(input.reservation())) {
            route.requests().addTokens(1);
            route.circuit().releasePermission();
            throw new Failure(Fault.TEMPORARY, "Provider TPM exhausted");
        }
        try { beforeDispatch.run(); }
        catch (RuntimeException denied) {
            route.requests().addTokens(1);
            route.tokens().addTokens(input.reservation());
            route.circuit().releasePermission();
            throw denied;
        }
        var sample = Timer.start(metrics);
        long started = System.nanoTime();
        var span = tracer.spanBuilder("studyhub.ai.call").setAttribute("gen_ai.request.model", p.model())
                .setAttribute("studyhub.provider", id).setAttribute("studyhub.receipt", receipt).startSpan();
        try (var linked = span.makeCurrent()) {
            var format = p.jsonSchema() ? new ResponseFormat(ResponseFormat.Type.JSON_SCHEMA, input.schema())
                    : new ResponseFormat(ResponseFormat.Type.JSON_OBJECT, (String) null);
            var options = OpenAiChatOptions.builder().model(p.model()).maxTokens(input.outputLimit()).responseFormat(format)
                    .httpHeaders(Map.of("Idempotency-Key", receipt)).build();
            var prompt = new Prompt(List.of(new SystemMessage(input.prefix()), new UserMessage(input.task())), options);
            var response = route.model().call(prompt);
            long elapsed = System.nanoTime() - started;
            route.circuit().onSuccess(elapsed, java.util.concurrent.TimeUnit.NANOSECONDS);
            var usage = response.getMetadata().getUsage();
            long tokens = usage.getTotalTokens() == null || usage.getTotalTokens() <= 0
                    ? input.reservation() : usage.getTotalTokens();
            metrics.counter("studyhub.ai.tokens", "provider", id).increment(tokens);
            span.setAttribute("studyhub.tokens", tokens);
            if (usage.getNativeUsage() instanceof OpenAiApi.Usage raw && raw.promptTokensDetails() != null
                    && raw.promptTokensDetails().cachedTokens() != null) {
                metrics.counter("studyhub.ai.cached.tokens", "provider", id).increment(raw.promptTokensDetails().cachedTokens());
                span.setAttribute("studyhub.cached.tokens", raw.promptTokensDetails().cachedTokens().longValue());
            }
            String content = response.getResult() == null ? "" : response.getResult().getOutput().getText();
            return new Reply(validated(input.review(), input.publication(), content, tokens), tokens);
        } catch (Failure invalid) {
            span.setStatus(StatusCode.ERROR, invalid.kind.name());
            throw invalid;
        } catch (RuntimeException ex) {
            Failure failure;
            if (ex instanceof RestClientResponseException http && http.getStatusCode().is4xxClientError()) {
                int code = http.getStatusCode().value();
                Fault kind = switch (code) {
                    case 429 -> Fault.TEMPORARY;
                    case 408, 409 -> Fault.AMBIGUOUS;
                    default -> Fault.PERMANENT;
                };
                failure = new Failure(kind, "Provider HTTP " + code);
            } else {
                failure = new Failure(Fault.AMBIGUOUS, "Provider outcome unknown; reconcile the receipt");
            }
            route.circuit().onError(System.nanoTime() - started, java.util.concurrent.TimeUnit.NANOSECONDS, failure);
            span.setStatus(StatusCode.ERROR, failure.kind.name());
            throw failure;
        } finally {
            span.end();
            sample.stop(Timer.builder("studyhub.ai.latency").tag("provider", id)
                    .publishPercentileHistogram().publishPercentiles(0.95).register(metrics));
        }
    }

    @Override public void close() { transport.shutdownNow(); }
}
