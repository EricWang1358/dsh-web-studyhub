package io.studyhub.domain;

import org.junit.jupiter.api.Test;
import java.time.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class LocalFsrsFitterTest {
    @Test void localFitLowersObservedLossWithoutChangingOtherParametersOrInput() {
        var start = Instant.parse("2026-01-01T12:00:00Z");
        var zone = ZoneId.of("UTC");
        var histories = new ArrayList<LocalFsrsFitter.History>();
        for (int i = 0; i < 24; i++) {
            histories.add(new LocalFsrsFitter.History(zone, List.of(
                new LocalFsrsFitter.Answer(start, 4),
                new LocalFsrsFitter.Answer(start.plusSeconds(600), 4),
                new LocalFsrsFitter.Answer(start.plus(Duration.ofDays(3 + i % 5)), i % 3 == 0 ? 4 : 0))));
        }
        var baseline = Fsrs6.Settings.defaults();
        var fit = LocalFsrsFitter.fit(histories, baseline, 24);
        assertEquals(24, fit.observations());
        assertTrue(fit.iterations() > 1);
        assertTrue(fit.after() < fit.before() - .1);
        assertEquals(2.3065, baseline.weights()[2]);
        for (int i = 4; i < 20; i++) assertEquals(baseline.weights()[i], fit.settings().weights()[i]);
        assertThrows(IllegalArgumentException.class, () -> LocalFsrsFitter.fit(List.of(), baseline, 1));
    }
}
