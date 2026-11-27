package io.studyhub.gateway;

import java.util.concurrent.Callable;
import java.util.concurrent.locks.Lock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import org.springframework.stereotype.Component;

/** Ordinary Node calls can overlap. A native publication owns the active library across its multi-call decision and write. */
@Component
final class LibraryAccess {
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock(true);

    Lock ordinary() { return lock.readLock(); }

    <T> T reviewed(Callable<T> operation) throws Exception {
        var exclusive = lock.writeLock();
        exclusive.lockInterruptibly();
        try { return operation.call(); }
        finally { exclusive.unlock(); }
    }
}
