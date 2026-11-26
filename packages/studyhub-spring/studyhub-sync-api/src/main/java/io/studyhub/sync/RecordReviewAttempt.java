package io.studyhub.sync;

import io.studyhub.domain.Fsrs6;
import io.studyhub.domain.sync.StudyOp;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ConcurrentModificationException;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

/** Native learner reviews. One encrypted immutable operation serves as receipt, outbox and projection input. */
public final class RecordReviewAttempt {
    private final SyncReplica replica;
    private final Supplier<ZoneId> defaultZone;
    private final Supplier<Fsrs6.Settings> defaultSettings;

    public RecordReviewAttempt(SyncReplica replica) {
        this(replica, ZoneId::systemDefault, Fsrs6.Settings::defaults);
    }
    public RecordReviewAttempt(SyncReplica replica, Supplier<ZoneId> defaultZone, Supplier<Fsrs6.Settings> defaultSettings) {
        this.replica = Objects.requireNonNull(replica);
        this.defaultZone = Objects.requireNonNull(defaultZone);
        this.defaultSettings = Objects.requireNonNull(defaultSettings);
    }

    /** Null inputs mean use the first-issued value. An explicitly different input conflicts with the original receipt. */
    public StudyOp record(UUID operationId, StudyOp.CardKey card, int grade, Instant at, ZoneId zone,
                          Fsrs6.Settings settings) throws SQLException {
        return replica.issue(operationId, (c, layout, stamp, existing) -> {
            if (existing != null && existing.kind() != StudyOp.Kind.ATTEMPT)
                throw new ConcurrentModificationException("Operation ID already used for another action");
            var previous = existing == null ? null : existing.answer();
            Instant issuedAt = at;
            if (issuedAt == null) issuedAt = previous == null ? replica.now() : previous.at();
            ZoneId issuedZone = zone;
            if (issuedZone == null) issuedZone = previous == null ? defaultZone.get() : ZoneId.of(previous.zone());
            Fsrs6.Settings issuedSettings = settings;
            if (issuedSettings == null) issuedSettings = previous == null ? defaultSettings.get() : previous.settings();
            var answer = StudyOp.Answer.issued(issuedAt, issuedZone, grade, issuedSettings);
            return new StudyOp(1, operationId, stamp, card, StudyOp.Kind.ATTEMPT, answer, null, null);
        });
    }

    public StudyOp undo(UUID operationId, StudyOp.CardKey card, UUID attemptId) throws SQLException {
        return compensate(operationId, card, StudyOp.Kind.UNDO, new StudyOp.Compensation(attemptId, null));
    }
    public StudyOp correct(UUID operationId, StudyOp.CardKey card, UUID attemptId, int grade) throws SQLException {
        return compensate(operationId, card, StudyOp.Kind.CORRECT, new StudyOp.Compensation(attemptId, grade));
    }
    private StudyOp compensate(UUID operationId, StudyOp.CardKey card, StudyOp.Kind kind, StudyOp.Compensation change) throws SQLException {
        return replica.issue(operationId, (c, layout, stamp, existing) -> {
            var op = new StudyOp(kind.version(), operationId, stamp, card, kind, null, null, null, change);
            if (existing != null) return op;
            var target = replica.find(c, layout, change.attemptId());
            if (target == null || target.kind() != StudyOp.Kind.ATTEMPT || !card.equals(target.key()))
                throw new IllegalArgumentException("No native attempt with this identity on this card");
            // The journal is encrypted. Only explicit compensations inspect earlier voids, inside the same writer transaction.
            boolean undone = replica.operations(c,layout).stream().anyMatch(prior -> prior.kind() == StudyOp.Kind.UNDO
                && card.equals(prior.key()) && prior.compensation().attemptId().equals(target.id()));
            if (undone) throw new ConcurrentModificationException("Attempt has already been undone");
            return op;
        });
    }
}
