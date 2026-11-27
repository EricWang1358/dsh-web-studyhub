package io.studyhub.ai;

import java.util.ArrayList;
import java.util.List;

public final class Workflow {
    private Workflow() {}

    public record Request(String id, String source, List<String> topics, String author, String reviewer, String fallback,
                          boolean publication) {
        public Request(String id, String source, List<String> topics, String author, String reviewer, String fallback) {
            this(id, source, topics, author, reviewer, fallback, false);
        }
        public Request {
            if (id == null || !id.matches("[A-Za-z0-9_-]{1,96}")) throw new IllegalArgumentException("Invalid workflow id");
            if (source == null || source.isBlank()) throw new IllegalArgumentException("Source text is required");
            if (topics == null || topics.isEmpty() || topics.stream().anyMatch(t -> t == null || t.isBlank())) {
                throw new IllegalArgumentException("Nonempty topics are required");
            }
            topics = List.copyOf(topics);
            if (author == null || reviewer == null) throw new IllegalArgumentException("Author and reviewer are required");
        }
    }

    public enum Status { QUEUED, RUNNING, CANCELLING, CANCELLED, PAUSED, RECONCILE, FAILED, SUCCEEDED }
    public enum StepState { PENDING, INTENT, DONE, UNKNOWN, FAILED }
    public record Provider(String family, String model, String baseUrl, String keyEnv, boolean jsonSchema) {
        public Provider {
            if (family == null || family.isBlank() || model == null || model.isBlank() || baseUrl == null
                    || baseUrl.isBlank()) throw new IllegalArgumentException("Incomplete model provider");
        }
    }
    record Plan(Request request, Provider author, Provider reviewer, Provider fallback, int outputLimit, long budget) {}

    public record Stage(String key, String receipt, StepState state, String provider, String result, long tokens,
                        long reserved, long startedAt, long finishedAt, String detail) {
        Stage intent(String route, long allowance) {
            return new Stage(key, receipt, StepState.INTENT, route, null, 0, allowance,
                    System.currentTimeMillis(), 0, "");
        }
        Stage end(StepState next, String json, long used, String detail) {
            long held = next == StepState.UNKNOWN ? reserved : 0;
            return new Stage(key, receipt, next, provider, json, used, held, startedAt, System.currentTimeMillis(), detail);
        }
    }

    record Job(Plan plan, Status status, List<Stage> stages, long revision, String detail) {
        Job {
            stages = List.copyOf(stages);
        }
        Job withStatus(Status next, String reason) {
            return new Job(plan, next, stages, revision + 1, reason);
        }
        Job replace(int index, Stage stage) {
            var next = new ArrayList<>(stages);
            next.set(index, stage);
            return new Job(plan, status, next, revision + 1, detail);
        }
        View view() { return new View(plan.request().id(), status, stages, revision, detail); }
    }
    public record View(String id, Status status, List<Stage> stages, long revision, String detail) {}

    public record ConsoleJob(String id, String title, Status status, String stage, int done, int total,
                             long tokens, int answered, long startedAt) {
        static ConsoleJob of(Job job) {
            var stages = job.stages();
            var active = stages.stream().filter(s -> s.state() == StepState.INTENT).findFirst();
            return new ConsoleJob(job.plan().request().id(), job.plan().request().topics().getFirst(),
                    job.status(), active.map(Stage::key).orElse(job.detail()),
                    (int) stages.stream().filter(s -> s.state() == StepState.DONE).count(),
                    stages.size(), stages.stream().mapToLong(Stage::tokens).sum(),
                    (int) stages.stream().filter(s -> s.tokens() > 0).count(),
                    stages.stream().mapToLong(Stage::startedAt).filter(t -> t > 0).min().orElse(0));
        }
        public boolean live() {
            return status == Status.QUEUED || status == Status.RUNNING || status == Status.PAUSED || status == Status.CANCELLING;
        }
    }
}
