package io.studyhub.domain.sync;

import java.util.Objects;

/** Total order for events from devices whose wall clocks can move backwards. */
public record HybridTime(long millis, long counter, String device) implements Comparable<HybridTime> {
    public HybridTime {
        if (millis < 0 || counter < 0 || Objects.requireNonNull(device).isBlank())
            throw new IllegalArgumentException("Invalid hybrid clock");
    }
    public static HybridTime next(long now, String device, HybridTime local, HybridTime received) {
        long previous = local == null ? -1 : local.millis, remote = received == null ? -1 : received.millis;
        long wall = Math.max(now, Math.max(previous, remote));
        long logical = Math.max(previous == wall ? local.counter : -1, remote == wall ? received.counter : -1);
        return new HybridTime(wall, Math.addExact(logical, 1), device);
    }
    @Override public int compareTo(HybridTime o) {
        int c = Long.compare(millis, o.millis);
        if (c == 0) c = Long.compare(counter, o.counter);
        return c == 0 ? device.compareTo(o.device) : c;
    }
}
