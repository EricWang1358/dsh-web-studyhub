package io.studyhub.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.github.resilience4j.retry.Retry;
import io.github.resilience4j.retry.RetryConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Context;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.StructuredTaskScope;
import java.util.concurrent.locks.ReentrantLock;
import static io.studyhub.ai.Workflow.*;
import static io.studyhub.ai.ProviderRouter.*;

/** An immutable request creates one author per topic, then a single different-family review of all drafts. */
public final class WorkflowService implements AutoCloseable {
    private final WorkflowSettings settings;
    private final WorkflowStore store;
    private final ProviderRouter router;
    private final Tracer tracer;
    private final Semaphore permits;
    private final Map<String, Thread> workers = new ConcurrentHashMap<>();
    private final ReentrantLock lifecycle = new ReentrantLock();
    private boolean closing;
    private final Retry safeRetry = Retry.of("admission", RetryConfig.custom().maxAttempts(2)
            .waitDuration(Duration.ofMillis(250))
            .retryOnException(t -> t instanceof Failure f && f.kind == Fault.TEMPORARY).build());

    public WorkflowService(Path directory, WorkflowSettings settings, ObjectMapper json, MeterRegistry metrics,
                           ProviderSecrets secrets) throws Exception {
        this(directory, settings, json, metrics, secrets, GlobalOpenTelemetry.get());
    }

    WorkflowService(Path directory, WorkflowSettings settings, ObjectMapper json, MeterRegistry metrics,
                    ProviderSecrets secrets, OpenTelemetry telemetry) throws Exception {
        this.settings = settings;
        tracer = telemetry.getTracer("io.studyhub.workflow");
        store = new WorkflowStore(directory, json);
        router = new ProviderRouter(settings, metrics, json, secrets, tracer);
        permits = new Semaphore(settings.concurrency(), true);
        try {
            for (String id : store.ids()) {
                var old = store.read(id);
                if (old.status() != Status.RUNNING && old.status() != Status.QUEUED && old.status() != Status.CANCELLING) continue;
                var recovered = store.mutate(id, job -> {
                    for (int i = 0; i < job.stages().size(); i++) {
                        var stage = job.stages().get(i);
                        if (stage.state() == StepState.INTENT) job = job.replace(i,
                                stage.end(StepState.UNKNOWN, null, 0, "Interrupted after persisting provider intent"));
                    }
                    return job;
                });
                if (recovered.status() == Status.CANCELLING || has(recovered, StepState.UNKNOWN)) settle(id);
                else launch(id);
            }
        } catch (RuntimeException failure) {
            close();
            throw failure;
        }
    }

    public View start(Request request) {
        if (request.topics().size() > settings.maxTopics() || request.source().getBytes(StandardCharsets.UTF_8).length > settings.maxSourceBytes()
                || request.topics().stream().anyMatch(t -> t.getBytes(StandardCharsets.UTF_8).length > settings.maxSourceBytes())) {
            throw new IllegalArgumentException("Source or topic limits exceeded");
        }
        lifecycle.lock();
        try {
            ensureOpen();
            // Idempotent replays keep their persisted route even when configuration changed.
            try {
                var old = store.read(request.id());
                if (!old.plan().request().equals(request)) throw new IllegalArgumentException("Conflicting workflow request");
                return old.view();
            } catch (java.util.NoSuchElementException fresh) {
                // A caller-supplied stable id is inserted with all stage receipts before any work starts.
            }
            var author = settings.provider(request.author());
            var reviewer = settings.provider(request.reviewer());
            var fallback = request.fallback() == null || request.fallback().isBlank() ? null : settings.provider(request.fallback());
            if (author.family().equalsIgnoreCase(reviewer.family())
                    || fallback != null && fallback.family().equalsIgnoreCase(reviewer.family())) {
                throw new IllegalArgumentException("Reviewer must belong to a different model family from every author route");
            }
            var stages = new ArrayList<Stage>();
            for (int i = 0; i <= request.topics().size(); i++) {
                String key = i == request.topics().size() ? "review" : "author-" + i;
                stages.add(new Stage(key, UUID.randomUUID().toString(), StepState.PENDING, "", null, 0, 0, 0, 0, ""));
            }
            var plan = new Plan(request, author, reviewer, fallback, settings.outputTokens(), settings.tokenBudget());
            var job = store.insert(new Job(plan, Status.QUEUED, stages, 1, ""));
            launch(request.id());
            return job.view();
        } finally { lifecycle.unlock(); }
    }

    private void launch(String id) {
        lifecycle.lock();
        try {
            ensureOpen();
            if (workers.containsKey(id)) return;
            Thread worker = Thread.ofVirtual().name("studyhub-workflow-" + id).unstarted(Context.current().wrap(() -> execute(id)));
            workers.put(id, worker);
            worker.start();
        } finally { lifecycle.unlock(); }
    }

    private void execute(String id) {
        var span = tracer.spanBuilder("studyhub.workflow.run").startSpan();
        try (var linked = span.makeCurrent()) {
            var job = store.mutate(id, before -> before.status() == Status.CANCELLING ? before : before.withStatus(Status.RUNNING, ""));
            if (job.status() != Status.RUNNING) return;
            int review = job.stages().size() - 1;
            try (var scope = new StructuredTaskScope<Void>()) {
                var tasks = new ArrayList<StructuredTaskScope.Subtask<Void>>();
                for (int i = 0; i < review; i++) {
                    final int index = i;
                    if (job.stages().get(i).state() == StepState.PENDING) {
                        tasks.add(scope.fork(Context.current().wrap(() -> { stage(id, index); return (Void) null; })));
                    }
                }
                scope.join();
                for (var task : tasks) {
                    if (task.state() == StructuredTaskScope.Subtask.State.FAILED) {
                        throw new IllegalStateException("Author worker failed", task.exception());
                    }
                }
            }
            job = store.read(id);
            if (job.status() == Status.RUNNING && job.stages().subList(0, review).stream()
                    .allMatch(s -> s.state() == StepState.DONE) && job.stages().get(review).state() == StepState.PENDING) {
                stage(id, review);
            }
        } catch (InterruptedException | CancellationException interrupted) {
            // Scope.close joins the children first. A durably issued but unacknowledged call stays unknown.
        } catch (RuntimeException failure) {
            store.mutate(id, job -> job.withStatus(Status.FAILED, "Workflow guard failed: " + failure.getClass().getSimpleName()));
        } finally {
            lifecycle.lock();
            try {
                var finalState = settle(id);
                span.setAttribute("studyhub.workflow.status", finalState.status().name());
                if (finalState.status() == Status.FAILED || finalState.status() == Status.RECONCILE) span.setStatus(StatusCode.ERROR);
            } finally { workers.remove(id); lifecycle.unlock(); span.end(); }
        }
    }

    private void stage(String id, int index) throws InterruptedException {
        permits.acquire();
        try {
            var job = store.read(id);
            if (job.status() != Status.RUNNING) return;
            var plan = job.plan();
            var input = router.input(job, index);
            var route = input.review() ? plan.reviewer() : plan.author();
            String name = input.review() ? plan.request().reviewer() : plan.request().author();
            var span = tracer.spanBuilder("studyhub.workflow.stage").setAttribute("studyhub.stage", job.stages().get(index).key())
                    .setAttribute("studyhub.receipt", job.stages().get(index).receipt()).startSpan();
            try (var linked = span.makeCurrent()) {
                attempt(id, index, input, name, route);
            } catch (Failure refusal) {
                if (!input.review() && plan.fallback() != null && refusal.kind == Fault.TEMPORARY) {
                    try (var linked = span.makeCurrent()) { attempt(id, index, input, plan.request().fallback(), plan.fallback()); }
                }
            } finally { span.end(); }
        } catch (Failure alreadyRecorded) {
            // attempt persisted the final failure before releasing its slot.
        } finally { permits.release(); }
    }

    private void attempt(String id, int index, Input input, String name, Provider route) {
        safeRetry.executeRunnable(() -> {
            var snapshot = store.read(id);
            String receipt = snapshot.stages().get(index).receipt();
            if (snapshot.status() != Status.RUNNING || Thread.currentThread().isInterrupted()) throw new CancellationException();
            try {
                var reply = router.call(name, route, input, receipt, () -> store.mutate(id, job -> {
                    if (job.status() != Status.RUNNING || Thread.currentThread().isInterrupted()) throw new CancellationException();
                    long available = job.plan().budget();
                    for (Stage s : job.stages()) {
                        available -= Math.min(available, s.tokens());
                        available -= Math.min(available, s.reserved());
                    }
                    if (input.reservation() > available) throw new Failure(Fault.PERMANENT, "Job token budget exceeded");
                    return job.replace(index, job.stages().get(index).intent(name, input.reservation()));
                }));
                store.mutate(id, job -> job.replace(index, job.stages().get(index)
                        .end(StepState.DONE, reply.content(), reply.tokens(), "")));
            } catch (Failure failure) {
                var state = switch (failure.kind) {
                    case AMBIGUOUS -> StepState.UNKNOWN;
                    case PERMANENT, INVALID_OUTPUT -> StepState.FAILED;
                    case TEMPORARY -> StepState.PENDING;
                };
                store.mutate(id, job -> job.replace(index, job.stages().get(index)
                        .end(state, null, failure.charged, failure.getMessage())));
                throw failure;
            }
        });
    }

    private Job settle(String id) {
        return store.mutate(id, job -> {
            for (int i = 0; i < job.stages().size(); i++) {
                Stage step = job.stages().get(i);
                if (step.state() == StepState.INTENT) job = job.replace(i, step.end(StepState.UNKNOWN, null, 0, "Dispatch outcome unknown"));
            }
            if (job.status() == Status.CANCELLING) return job.withStatus(Status.CANCELLED, "Local execution stopped");
            if (has(job, StepState.UNKNOWN)) return job.withStatus(Status.RECONCILE, "Compare outstanding receipts with provider records");
            if (job.status() == Status.FAILED) return job;
            if (has(job, StepState.FAILED)) return job.withStatus(Status.FAILED, "A stage failed permanently");
            if (has(job, StepState.PENDING)) return closing ? job.withStatus(Status.QUEUED, "Waiting for engine restart")
                    : job.withStatus(Status.PAUSED, "Resume after provider admission is available");
            return job.withStatus(Status.SUCCEEDED, "");
        });
    }

    private static boolean has(Job job, StepState state) {
        return job.stages().stream().anyMatch(s -> s.state() == state);
    }
    private void ensureOpen() { if (closing) throw new IllegalStateException("Workflow engine is closing"); }

    public View status(String id) { return store.read(id).view(); }
    public List<ConsoleJob> liveJobs() { return store.live(); }
    public ConsoleJob consoleJob(String id) { return ConsoleJob.of(store.read(id)); }
    public List<View> list() { return store.ids().stream().map(this::status).toList(); }
    public View await(String id, long revision, long timeoutMillis) throws InterruptedException { return store.await(id, revision, timeoutMillis); }

    public View resume(String id) {
        lifecycle.lock();
        try {
            ensureOpen();
            var job = store.read(id);
            if (job.status() == Status.SUCCEEDED || workers.containsKey(id)) return job.view();
            if (has(job, StepState.UNKNOWN) || has(job, StepState.FAILED)) throw new IllegalStateException("Resolve outstanding stages before resume");
            store.mutate(id, j -> j.withStatus(Status.QUEUED, ""));
            launch(id);
            return status(id);
        } finally { lifecycle.unlock(); }
    }

    public View cancel(String id) {
        lifecycle.lock();
        try {
            ensureOpen();
            var job = store.read(id);
            Thread worker = workers.get(id);
            if (worker == null) {
                if (job.status() == Status.PAUSED || job.status() == Status.RECONCILE) {
                    return store.mutate(id, j -> j.withStatus(Status.CANCELLED, "Local execution stopped")).view();
                }
                return job.view();
            }
            var cancelling = store.mutate(id, j -> j.withStatus(Status.CANCELLING, "Stopping local workers"));
            worker.interrupt();
            return cancelling.view();
        } finally { lifecycle.unlock(); }
    }

    public View reconcile(String id, String receipt, String recoveredJson, long tokens) {
        if (tokens < 0) throw new IllegalArgumentException("Invalid token count");
        lifecycle.lock();
        try {
            ensureOpen();
            if (workers.containsKey(id)) throw new IllegalStateException("Wait for local execution to stop");
            return store.mutate(id, j -> {
                for (int i = 0; i < j.stages().size(); i++) {
                    var s = j.stages().get(i);
                    if (!s.receipt().equals(receipt) || s.state() != StepState.UNKNOWN) continue;
                    String result = router.validated(i == j.stages().size() - 1, j.plan().request().publication(), recoveredJson, tokens);
                    var next = j.replace(i, s.end(StepState.DONE, result, tokens, "Reconciled against provider response"));
                    return next.withStatus(has(next, StepState.UNKNOWN) ? Status.RECONCILE : Status.PAUSED, "");
                }
                throw new IllegalArgumentException("Unknown outstanding receipt");
            }).view();
        } finally { lifecycle.unlock(); }
    }

    @Override
    public void close() throws Exception {
        List<Thread> active;
        lifecycle.lock();
        try {
            if (closing) return;
            closing = true;
            active = List.copyOf(workers.values());
            active.forEach(Thread::interrupt);
        } finally { lifecycle.unlock(); }
        for (Thread worker : active) worker.join();
        try { router.close(); } finally { store.close(); }
    }
}
