package io.studyhub.platform.spi;

import java.io.IOException;
import java.net.URI;

/** The supplied URI is the running local StudyHub server. */
public interface DesktopHost extends AutoCloseable {
    void open(URI location, Runnable quit) throws IOException;
    @Override default void close() {}
}
