package io.studyhub.domain;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Objects;

/** Deterministic whole-day FSRS-6 with StudyHub's same-day isolation and exam alignment.
 * Equations and defaults correspond to ts-fsrs 5.4.2 (see META-INF/ts-fsrs-LICENSE.txt). */
public final class Fsrs6 {
    private Fsrs6() {}

    public static final int MAX_DAYS = 36500;
    private static final double[] DEFAULT = {
        0.212,1.2931,2.3065,8.2956,6.4133,0.8334,3.0194,0.001,1.8722,0.1666,
        0.796,1.4835,0.0614,0.2629,1.6483,0.6014,1.8729,0.5425,0.0912,0.0658,0.1542
    };
    private static final double[] LOWER = {
        .001,.001,.001,.001,1,.001,.001,.001,0,0,.001,.001,.001,.001,0,0,1,0,0,0,.1
    };
    private static final double[] UPPER = {
        100,100,100,100,10,4,4,.75,4.5,.8,3.5,5,.25,.9,4,1,6,2,2,.8,.8
    };

    public record Settings(double retention, int maximumInterval, boolean isolateSameDay,
                           LocalDate examDate, double[] weights) {
        public Settings {
            if (!(retention >= .7 && retention <= .97) || maximumInterval < 1 || maximumInterval > MAX_DAYS)
                throw new IllegalArgumentException("Invalid scheduling settings");
            weights = weights.clone();
            if (weights.length != DEFAULT.length) throw new IllegalArgumentException("Expected 21 FSRS-6 weights");
            for (double weight : weights)
                if (!Double.isFinite(weight)) throw new IllegalArgumentException("Non-finite FSRS-6 weight");
        }
        public Settings(double retention, int maximumInterval, boolean isolateSameDay) {
            this(retention, maximumInterval, isolateSameDay, null, DEFAULT);
        }
        public static Settings defaults() { return new Settings(.9, MAX_DAYS, true); }
        @Override public double[] weights() { return weights.clone(); }
        public Settings withWeights(double[] fitted) {
            return new Settings(retention, maximumInterval, isolateSameDay, examDate, fitted);
        }
    }

    public record Review(double stability, double difficulty, int reps, int lapses, int repetitions,
                         int spacedReps, Integer lastGrade, int intervalDays, long elapsedDays,
                         Instant lastReview, Instant dueAt, Instant lastLapseAt, Instant unalignedDueAt) {
        public static Review fresh() { return new Review(0, 0, 0, 0, 0, 0, null, 0, 0, null, null, null, null); }
        public static Review fromSm2(int repetitions, int interval, double ease, Instant dueAt, Instant now) {
            if (interval <= 0) return fresh();
            double difficulty = Math.clamp(10 - ((ease > 0 ? ease : 2.5) - 1.3) * 9 / 2.2, 1, 10);
            double stability = Math.min(interval, MAX_DAYS);
            return new Review(stability, difficulty, repetitions, 0, repetitions, repetitions, null, interval, 0,
                Objects.requireNonNullElse(dueAt, now).minus((long) stability, ChronoUnit.DAYS), dueAt, null, null);
        }
        public double easeFactor() {
            return stability == 0 ? 2.5 : Math.round((1.3 + (10 - difficulty) * 2.2 / 9) * 100) / 100.0;
        }
    }

    static double[] clipped(Settings settings) {
        double[] w = settings.weights();
        for (int i = 0; i < w.length; i++) w[i] = Math.clamp(w[i], LOWER[i], UPPER[i]);
        return w;
    }

    private static long days(Instant from, Instant to, ZoneId zone) {
        return ChronoUnit.DAYS.between(from.atZone(zone).toLocalDate(), to.atZone(zone).toLocalDate());
    }
    private static double round(double x) { return Math.round(x * 1e8) / 1e8; }
    private static double initialDifficulty(int rating, double[] w) {
        return round(w[4] - Math.exp((rating - 1) * w[5]) + 1);
    }
    private static double factor(double decay) { return round(Math.exp(Math.log(.9) / -decay) - 1); }
    private static double recall(long days, double stability, double decay) {
        return round(Math.pow(1 + factor(decay) * days / stability, -decay));
    }
    public static double retrievability(Review before, Instant at, ZoneId zone, Settings settings) {
        if (before.lastReview == null || before.stability == 0) return 0;
        return recall(Math.max(0, days(before.lastReview, at, zone)), before.stability, clipped(settings)[20]);
    }

    private record State(double stability, double difficulty) {}
    private static State next(Review old, int rating, double r, double[] w) {
        double s = old.stability, d = old.difficulty;
        if (s == 0) return new State(Math.max(.1, w[rating - 1]), Math.clamp(initialDifficulty(rating, w), 1, 10));
        double adjustment = round(-w[6] * (rating - 3) * (10 - d) / 9);
        double nextD = Math.clamp(round(w[7] * initialDifficulty(4, w) + (1 - w[7]) * (d + adjustment)), 1, 10);
        double nextS;
        if (rating == 1) {
            double forgotten = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]);
            nextS = Math.min(round(s), forgotten);
        } else {
            double gain = Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1);
            nextS = s * (1 + gain * (rating == 2 ? w[15] : 1) * (rating == 4 ? w[16] : 1));
        }
        return new State(round(Math.clamp(nextS, .001, MAX_DAYS)), nextD);
    }

    public static Review schedule(Review before, int grade, Instant at, ZoneId zone, Settings settings) {
        if (grade < 0 || grade > 5) throw new IllegalArgumentException("Grade must be 0 through 5");
        int rating = Math.max(1, grade - 1);
        long elapsed = before.lastReview == null ? 0 : Math.max(0, days(before.lastReview, at, zone));
        boolean sameDay = before.lastReview != null && elapsed == 0;
        boolean passed = sameDay && (before.spacedReps > 0 || before.repetitions > 0);
        boolean lapsed = sameDay && (before.lastLapseAt != null ? days(before.lastLapseAt, at, zone) == 0 : !passed);
        boolean isolate = sameDay && settings.isolateSameDay;
        double[] w = clipped(settings);
        double recall = before.stability == 0 ? 1 : recall(elapsed, before.stability, w[20]);
        double modifier = round((Math.pow(settings.retention, -1 / w[20]) - 1) / factor(w[20]));
        State[] states = new State[5];
        int[] gaps = new int[5];
        for (int i = 1; i <= 4; i++) {
            states[i] = next(before, i, recall, w);
            gaps[i] = (int) Math.clamp(Math.round(states[i].stability * modifier), 1, settings.maximumInterval);
        }
        gaps[1] = Math.min(gaps[1], gaps[2]);
        for (int i = 2; i <= 4; i++) gaps[i] = Math.max(gaps[i], gaps[i - 1] + 1);
        State selected = states[rating];
        int interval = gaps[rating];
        if (isolate && rating > 1 && passed) {
            selected = new State(before.stability, before.difficulty);
            if (before.intervalDays > 0) interval = before.intervalDays;
        } else if (isolate && rating > 1) {
            double target = rating == 2 ? settings.weights[1] * .5 : settings.weights[2] * (rating == 3 ? .65 : .75);
            selected = new State(Math.clamp(Math.max(before.stability, round(target)), .001, MAX_DAYS), before.difficulty);
            interval = rating == 4 ? 2 : 1;
        } else if (isolate && lapsed) {
            selected = new State(before.stability, before.difficulty);
            interval = 1;
        }
        interval = Math.min(settings.maximumInterval, interval);
        Instant due = at.plus(interval, ChronoUnit.DAYS);
        Instant previousDue = before.unalignedDueAt == null ? before.dueAt : before.unalignedDueAt;
        if (isolate && passed && rating > 1 && before.intervalDays <= settings.maximumInterval
            && previousDue != null && previousDue.isAfter(due)) due = previousDue;
        Instant unaligned = null;
        if (settings.examDate != null) {
            long examDays = ChronoUnit.DAYS.between(at.atZone(zone).toLocalDate(), settings.examDate);
            if (examDays >= 1 && interval >= examDays) {
                if (due.atZone(zone).toLocalDate().isAfter(settings.examDate)) unaligned = due;
                due = settings.examDate.atStartOfDay(zone).toInstant();
            }
        }
        Instant lapseAt = rating == 1 ? at : isolate && lapsed
            ? Objects.requireNonNullElse(before.lastLapseAt, before.lastReview) : null;
        return new Review(selected.stability, selected.difficulty, before.reps + 1,
            before.lapses + (rating == 1 && before.stability > 0 && !(isolate && lapsed) ? 1 : 0),
            rating == 1 ? 0 : isolate && passed ? Math.max(1, before.repetitions) : before.repetitions + 1,
            rating == 1 ? 0 : passed ? Math.max(1, before.spacedReps) : before.spacedReps + 1,
            rating > 1 && isolate && passed && before.lastGrade != null ? Math.max(grade, before.lastGrade) : grade,
            interval, elapsed, at, due, lapseAt, unaligned);
    }
}
