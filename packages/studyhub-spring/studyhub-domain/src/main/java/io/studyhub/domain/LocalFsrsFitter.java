package io.studyhub.domain;

import java.time.Instant;
import java.time.ZoneId;
import java.util.*;
import java.util.function.ToDoubleFunction;

/** Local L-BFGS calibration of the four first-review stabilities and forgetting-curve decay.
 * Learner data remains with the caller. Other FSRS parameters retain their previous values. */
public final class LocalFsrsFitter {
    private LocalFsrsFitter() {}
    public record Answer(Instant at, int grade) {
        public Answer {
            Objects.requireNonNull(at);
            if (grade < 0 || grade > 5) throw new IllegalArgumentException("Expected a grade in 0..5");
        }
    }
    public record History(ZoneId zone, List<Answer> answers) {
        public History {
            Objects.requireNonNull(zone);
            answers = List.copyOf(answers);
            for (int i = 1; i < answers.size(); i++)
                if (answers.get(i).at.isBefore(answers.get(i - 1).at))
                    throw new IllegalArgumentException("Reviews must be chronological per card");
        }
    }
    public record Fit(Fsrs6.Settings settings, int observations, int iterations, double before, double after) {}
    private record Update(double[] step, double[] gradientChange, double reciprocalCurvature) {}
    private static final int[] INDICES = {0, 1, 2, 3, 20};
    private static final int MEMORY = 6;

    public static Fit fit(List<History> histories, Fsrs6.Settings baseline, int maxIterations) {
        if (maxIterations < 1) throw new IllegalArgumentException("maxIterations must be positive");
        histories = List.copyOf(histories);
        int observations = 0;
        for (History h : histories)
            for (int i = 1; i < h.answers.size(); i++)
                if (h.answers.get(i).at.atZone(h.zone).toLocalDate().isAfter(h.answers.get(i - 1).at.atZone(h.zone).toLocalDate())) observations++;
        if (observations == 0) throw new IllegalArgumentException("No cross-day recall observations");
        final List<History> sample = histories;
        final int count = observations;
        double[] start = coordinates(baseline);
        ToDoubleFunction<double[]> loss = x -> {
            Fsrs6.Settings settings = parameters(x, baseline);
            double total = 0;
            for (History history : sample) {
                var review = Fsrs6.Review.fresh();
                for (Answer answer : history.answers) {
                    double probability = Fsrs6.retrievability(review, answer.at, history.zone, settings);
                    if (review.lastReview() != null && answer.at.atZone(history.zone).toLocalDate()
                            .isAfter(review.lastReview().atZone(history.zone).toLocalDate())) {
                        probability = Math.clamp(probability, 1e-9, 1 - 1e-9);
                        total -= answer.grade >= 3 ? Math.log(probability) : Math.log1p(-probability);
                    }
                    review = Fsrs6.schedule(review, answer.grade, answer.at, history.zone, settings);
                }
            }
            // Weak local prior keeps small learning libraries near their existing parameters.
            double prior = 0;
            for (int i = 0; i < x.length; i++) prior += Math.pow(x[i] - start[i], 2);
            return (total + .01 * prior) / count;
        };
        double[] x = start.clone(), gradient = gradient(loss, x);
        double before = loss.applyAsDouble(x), current = before;
        List<Update> memory = new ArrayList<>();
        int iterations = 0;
        while (iterations < maxIterations && dot(gradient, gradient) > 1e-12) {
            double[] descent = direction(gradient, memory);
            double slope = dot(descent, gradient);
            if (slope >= 0) { descent = scaled(gradient, -1); slope = -dot(gradient, gradient); }
            double step = 1;
            double[] candidate;
            double value;
            do {
                candidate = x.clone();
                add(candidate, descent, step);
                value = loss.applyAsDouble(candidate);
                if (value <= current + 1e-4 * step * slope) break;
                step *= .5;
            } while (step > 1e-10);
            if (value >= current) break;
            double[] nextGradient = gradient(loss, candidate);
            double[] s = candidate.clone(), y = nextGradient.clone();
            add(s, x, -1);
            add(y, gradient, -1);
            double curvature = dot(s, y);
            if (curvature > 1e-12) {
                if (memory.size() == MEMORY) memory.removeFirst();
                memory.add(new Update(s, y, 1 / curvature));
            }
            gradient = nextGradient; x = candidate; current = value; iterations++;
        }
        return new Fit(parameters(x, baseline), observations, iterations, before, current);
    }

    private static double[] coordinates(Fsrs6.Settings baseline) {
        double[] w = Fsrs6.clipped(baseline), result = new double[INDICES.length];
        for (int i = 0; i < INDICES.length; i++) {
            double lo = i == 4 ? .1 : .001, hi = i == 4 ? .8 : 100;
            double fraction = Math.clamp((w[INDICES[i]] - lo) / (hi - lo), 1e-9, 1 - 1e-9);
            result[i] = Math.log(fraction / (1 - fraction));
        }
        return result;
    }

    private static Fsrs6.Settings parameters(double[] x, Fsrs6.Settings base) {
        double[] w = base.weights();
        for (int i = 0; i < x.length; i++) {
            double lo = i == 4 ? .1 : .001, hi = i == 4 ? .8 : 100;
            w[INDICES[i]] = lo + (hi - lo) / (1 + Math.exp(-x[i]));
        }
        return base.withWeights(w);
    }

    private static double[] gradient(ToDoubleFunction<double[]> loss, double[] x) {
        double[] result = new double[x.length], probe = x.clone();
        for (int i = 0; i < x.length; i++) {
            double h = .0005;
            probe[i] = x[i] + h;
            double upper = loss.applyAsDouble(probe);
            probe[i] = x[i] - h;
            result[i] = (upper - loss.applyAsDouble(probe)) / (2 * h);
            probe[i] = x[i];
        }
        return result;
    }

    // L-BFGS two-loop recursion; only MEMORY curvature pairs are retained.
    private static double[] direction(double[] gradient, List<Update> history) {
        double[] q = gradient.clone(), alpha = new double[history.size()];
        for (int i = history.size() - 1; i >= 0; i--) {
            var h = history.get(i);
            alpha[i] = h.reciprocalCurvature * dot(h.step, q);
            add(q, h.gradientChange, -alpha[i]);
        }
        if (!history.isEmpty()) {
            var h = history.getLast();
            q = scaled(q, dot(h.step, h.gradientChange) / dot(h.gradientChange, h.gradientChange));
        }
        for (int i = 0; i < history.size(); i++) {
            var h = history.get(i);
            add(q, h.step, alpha[i] - h.reciprocalCurvature * dot(h.gradientChange, q));
        }
        return scaled(q, -1);
    }
    private static double dot(double[] a, double[] b) {
        double v = 0; for (int i = 0; i < a.length; i++) v += a[i] * b[i]; return v;
    }
    private static void add(double[] target, double[] v, double factor) {
        for (int i = 0; i < v.length; i++) target[i] += v[i] * factor;
    }
    private static double[] scaled(double[] v, double factor) {
        double[] result = new double[v.length]; add(result, v, factor); return result;
    }
}
