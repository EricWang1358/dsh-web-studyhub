package io.studyhub.platform.vault;

import io.studyhub.platform.spi.SecretStore;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Optional;

/** Each replacement is written in the same directory before the atomic rename. */
public abstract class FileSecrets implements SecretStore {
    private final Path directory;

    protected FileSecrets(Path directory) { this.directory = directory; }

    protected abstract byte[] transform(String key, byte[] input, boolean encrypt) throws IOException;

    private Path file(String key) {
        if (key == null || key.isBlank()) throw new IllegalArgumentException("Empty secret name");
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(key.getBytes(StandardCharsets.UTF_8));
            return directory.resolve(HexFormat.of().formatHex(hash) + ".secret");
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    @Override public Optional<byte[]> read(String key) throws IOException {
        Path path = file(key);
        byte[] bytes;
        try { bytes = Files.readAllBytes(path); }
        catch (NoSuchFileException missing) { return Optional.empty(); }
        return Optional.of(transform(key, bytes, false));
    }

    @Override public void write(String key, byte[] value) throws IOException {
        Path path = file(key);
        byte[] sealed = transform(key, value, true);
        Files.createDirectories(directory);
        Path temporary = Files.createTempFile(directory, ".secret-", ".tmp");
        try {
            Files.write(temporary, sealed);
            Files.move(temporary, path, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }

    @Override public void delete(String key) throws IOException { Files.deleteIfExists(file(key)); }
}
