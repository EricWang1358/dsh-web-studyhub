package io.studyhub.domain.sync;

import io.studyhub.domain.Fsrs6;
import java.time.ZoneId;
import java.util.*;

/** Attempts form a grow-only set. Metadata and explicit delete/restore are independent LWW registers. */
public final class CardReplica {
    private static final Comparator<StudyOp> ORDER = Comparator.comparing(StudyOp::stamp).thenComparing(StudyOp::id);
    private CardReplica() {}
    public record AttemptView(UUID id, java.time.Instant at, int originalGrade, int grade, UUID correctionId, UUID undoId) {}
    public record View(boolean deleted, Map<String,String> metadata, List<UUID> attempts,
                       Fsrs6.Review review, List<AttemptView> history) {}

    private static StudyOp latest(StudyOp a, StudyOp b) { return ORDER.compare(a,b) > 0 ? a : b; }

    public static View project(StudyOp.CardKey key, Collection<StudyOp> journal) {
        Map<UUID, StudyOp> unique = new HashMap<>();
        Map<String, StudyOp> metadata = new HashMap<>();
        Map<UUID, StudyOp> corrections = new HashMap<>(), undos = new HashMap<>();
        List<StudyOp> attempts = new ArrayList<>();
        StudyOp existence = null;
        for (var op : journal) {
            if (!key.equals(op.key())) continue;
            var previous = unique.putIfAbsent(op.id(), op);
            if (previous != null) {
                if (!op.equals(previous)) throw new IllegalArgumentException("Conflicting immutable operation " + op.id());
                continue;
            }
            switch (op.kind()) {
                case ATTEMPT -> attempts.add(op);
                case SET -> metadata.merge(op.field(), op, CardReplica::latest);
                case CORRECT -> corrections.merge(op.compensation().attemptId(), op, CardReplica::latest);
                case UNDO -> undos.merge(op.compensation().attemptId(), op, CardReplica::latest);
                case DELETE, RESTORE -> { if (existence == null || ORDER.compare(op, existence) > 0) existence = op; }
                case BACKUP, DESKTOP_ATTEMPT -> { /* Independent encrypted snapshots. */ }
            }
        }
        attempts.sort(Comparator.comparing((StudyOp op) -> op.answer().at()).thenComparing(ORDER));
        var review = Fsrs6.Review.fresh();
        List<AttemptView> history = new ArrayList<>();
        List<UUID> active = new ArrayList<>();
        for (var op : attempts) {
            var a = op.answer();
            var corrected = corrections.get(op.id());
            var undone = undos.get(op.id());
            int grade = corrected == null ? a.grade() : corrected.compensation().grade();
            history.add(new AttemptView(op.id(), a.at(), a.grade(), grade,
                corrected == null ? null : corrected.id(), undone == null ? null : undone.id()));
            if (undone == null) {
                active.add(op.id());
                review = Fsrs6.schedule(review, grade, a.at(), ZoneId.of(a.zone()), a.settings());
            }
        }
        Map<String, String> fields = new TreeMap<>();
        metadata.forEach((k, v) -> fields.put(k, v.value()));
        return new View(existence != null && existence.kind() == StudyOp.Kind.DELETE, Map.copyOf(fields),
            List.copyOf(active), review, List.copyOf(history));
    }
}
