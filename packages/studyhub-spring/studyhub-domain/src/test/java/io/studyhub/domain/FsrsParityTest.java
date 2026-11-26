package io.studyhub.domain;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.*;
import java.time.*;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class FsrsParityTest {
    @TempDir Path temp;

    @Test void compareOneThousandHistoriesWithBothNodeSchedulers() throws Exception {
        Path oracle = Path.of("src/test/resources/fsrs-oracle.mjs").toRealPath();
        Path output = temp.resolve("golden.tsv");
        Process child = new ProcessBuilder("node", oracle.toString(), output.toString()).inheritIO().start();
        try {
            assertTrue(child.waitFor(90, TimeUnit.SECONDS), "FSRS oracle timed out");
            assertEquals(0, child.exitValue());
        } finally {
            child.destroyForcibly();
            child.waitFor();
        }
        var current = Fsrs6.Review.fresh();
        var raw = Fsrs6.Review.fresh();
        int rows = 0, histories = 0;
        double worst = 0;
        for (String line : Files.readAllLines(output)) {
            String[] v = line.split("\t");
            if (v[1].equals("0")) {
                current = Fsrs6.Review.fresh();
                raw = Fsrs6.Review.fresh();
                histories++;
            }
            ZoneId zone = ZoneId.of(v[2]);
            double retention = Double.parseDouble(v[3]);
            int maximum = Integer.parseInt(v[4]), grade = Integer.parseInt(v[6]);
            Instant at = Instant.ofEpochMilli(Long.parseLong(v[7]));
            current = Fsrs6.schedule(current, grade, at, zone, new Fsrs6.Settings(retention, maximum, Boolean.parseBoolean(v[5])));
            raw = Fsrs6.schedule(raw, grade, at, zone, new Fsrs6.Settings(retention, maximum, false));
            worst = Math.max(worst, Math.max(Math.abs(raw.stability() - Double.parseDouble(v[18])),
                Math.abs(raw.difficulty() - Double.parseDouble(v[19]))));
            assertEquals(Double.parseDouble(v[8]), current.stability(), 1e-7, line);
            assertEquals(Double.parseDouble(v[9]), current.difficulty(), 1e-7, line);
            assertEquals(Integer.parseInt(v[10]), current.intervalDays(), line);
            assertEquals(Long.parseLong(v[11]), current.dueAt().toEpochMilli(), line);
            assertEquals(Integer.parseInt(v[12]), current.reps(), line);
            assertEquals(Integer.parseInt(v[13]), current.repetitions(), line);
            assertEquals(Integer.parseInt(v[14]), current.spacedReps(), line);
            assertEquals(Integer.parseInt(v[15]), current.lapses(), line);
            assertEquals(Integer.valueOf(v[16]), current.lastGrade(), line);
            assertEquals(Long.parseLong(v[17]), current.lastLapseAt() == null ? 0 : current.lastLapseAt().toEpochMilli(), line);
            assertEquals(Double.parseDouble(v[18]), raw.stability(), 1e-7, line);
            assertEquals(Double.parseDouble(v[19]), raw.difficulty(), 1e-7, line);
            assertEquals(Integer.parseInt(v[20]), raw.intervalDays(), line);
            assertEquals(Integer.parseInt(v[21]), raw.lapses(), line);
            rows++;
        }
        assertEquals(1000, histories);
        assertEquals(14000, rows);
        System.out.printf("FSRS-6: %d histories, %d reviews, max absolute error vs ts-fsrs %.3g%n", histories, rows, worst);
    }

    @Test void alignExamAtLocalMidnightAcrossSpringDst() {
        var at = Instant.parse("2026-03-07T23:00:00Z");
        var exam = LocalDate.of(2026, 3, 10);
        var settings = new Fsrs6.Settings(.9, 36500, true, exam, Fsrs6.Settings.defaults().weights());
        var result = Fsrs6.schedule(Fsrs6.Review.fresh(), 5, at, ZoneId.of("America/New_York"), settings);
        assertEquals(Instant.parse("2026-03-10T04:00:00Z"), result.dueAt());
        assertEquals(at.plus(Duration.ofDays(result.intervalDays())), result.unalignedDueAt());
    }
}
