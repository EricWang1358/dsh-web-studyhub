package io.studyhub.domain.sync;

import io.studyhub.domain.Fsrs6;
import java.time.*;
import java.util.*;

/** A versioned immutable operation. id is generated once per user action and reused on replay. */
public record StudyOp(int version, UUID id, HybridTime stamp, CardKey key, Kind kind, Answer answer,
                      String field, String value, Compensation compensation) {
    public enum Kind {
        ATTEMPT(1), SET(1), DELETE(1), RESTORE(1), BACKUP(1), UNDO(2), CORRECT(2), DESKTOP_ATTEMPT(2);
        private final int version;
        Kind(int version) { this.version = version; }
        public int version() { return version; }
    }
    public record Compensation(UUID attemptId, Integer grade) {
        public Compensation {
            Objects.requireNonNull(attemptId);
            if (grade != null && (grade < 0 || grade > 5)) throw new IllegalArgumentException("Invalid correction grade");
        }
    }
    public record CardKey(String library, String course, String card) {
        public CardKey {
            if (library.isBlank() || course.isBlank() || card.isBlank()) throw new IllegalArgumentException("Incomplete card identity");
        }
    }
    public record Answer(Instant at, String zone, int grade, double retention, int maximumInterval,
                         boolean isolateSameDay, LocalDate examDate, List<Double> weights) {
        public Answer {
            Objects.requireNonNull(at);
            ZoneId.of(zone);
            if (grade < 0 || grade > 5) throw new IllegalArgumentException("Invalid grade");
            weights = List.copyOf(weights);
            new Fsrs6.Settings(retention, maximumInterval, isolateSameDay, examDate,
                weights.stream().mapToDouble(Double::doubleValue).toArray());
        }
        public static Answer issued(Instant at, ZoneId zone, int grade, Fsrs6.Settings settings) {
            return new Answer(at, zone.getId(), grade, settings.retention(), settings.maximumInterval(),
                settings.isolateSameDay(), settings.examDate(), Arrays.stream(settings.weights()).boxed().toList());
        }
        public Fsrs6.Settings settings() {
            return new Fsrs6.Settings(retention, maximumInterval, isolateSameDay, examDate,
                weights.stream().mapToDouble(Double::doubleValue).toArray());
        }
    }
    public StudyOp(int version, UUID id, HybridTime stamp, CardKey key, Kind kind, Answer answer,
                   String field, String value) {
        this(version, id, stamp, key, kind, answer, field, value, null);
    }
    public StudyOp {
        Objects.requireNonNull(id); Objects.requireNonNull(stamp); Objects.requireNonNull(kind);
        boolean compensates = kind == Kind.UNDO || kind == Kind.CORRECT;
        if (version != kind.version()) throw new IllegalArgumentException("Unsupported operation version");
        if (compensates != (compensation != null)) throw new IllegalArgumentException("Invalid compensation payload");
        if (compensates && (id.equals(compensation.attemptId) || (kind == Kind.CORRECT) != (compensation.grade != null)))
            throw new IllegalArgumentException("Invalid compensation target or grade");
        if ((kind == Kind.BACKUP || kind == Kind.DESKTOP_ATTEMPT) != (key == null))
            throw new IllegalArgumentException("Invalid operation scope");
        if ((kind == Kind.ATTEMPT) != (answer != null)) throw new IllegalArgumentException("Invalid attempt payload");
        if (kind == Kind.SET) {
            if (field == null || field.isBlank() || value == null) throw new IllegalArgumentException("Missing metadata");
        } else if (kind == Kind.DESKTOP_ATTEMPT) {
            if (field == null || field.isBlank() || value == null || value.isBlank())
                throw new IllegalArgumentException("Missing desktop library identity or attempt manifest");
        } else if (kind == Kind.BACKUP) {
            if (field != null || value == null) throw new IllegalArgumentException("Missing backup manifest");
        } else if (field != null || value != null) throw new IllegalArgumentException("Unexpected metadata");
    }
}
