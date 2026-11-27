package io.studyhub.platform.spi;

import java.io.IOException;
import java.util.Optional;

public interface SecretStore {
    Optional<byte[]> read(String key) throws IOException;
    void write(String key, byte[] value) throws IOException;
    void delete(String key) throws IOException;
}
