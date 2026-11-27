package io.studyhub.storage;

import java.io.*;
import java.nio.channels.FileChannel;
import java.nio.file.*;
import java.security.*;
import java.util.HexFormat;

/** Immutable SHA-256 blobs. A completed staged file becomes visible in a single directory operation. */
public final class BlobStore {
    private final Path directory;

    public BlobStore(Path directory) throws IOException {
        Files.createDirectories(directory);
        this.directory = directory.toRealPath();
    }

    public String put(InputStream input) throws IOException {
        MessageDigest sha;
        try { sha = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
        Path staged = Files.createTempFile(directory, ".upload-", ".tmp");
        try {
            try (OutputStream out = new DigestOutputStream(Files.newOutputStream(staged), sha)) {
                input.transferTo(out);
            }
            try (FileChannel out = FileChannel.open(staged, StandardOpenOption.WRITE)) { out.force(true); }
            String hash = HexFormat.of().formatHex(sha.digest());
            try {
                // An existing hash belongs to a completed writer. A hard link publishes without replacing it.
                Files.createLink(directory.resolve(hash), staged);
            } catch (FileAlreadyExistsException existing) {
                if (Files.mismatch(staged, directory.resolve(hash)) != -1)
                    throw new IOException("Existing blob does not match " + hash, existing);
            }
            return hash;
        } finally {
            Files.deleteIfExists(staged);
        }
    }

    public InputStream open(String hash) throws IOException {
        if (hash == null || !hash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Expected a SHA-256 hex digest");
        return Files.newInputStream(directory.resolve(hash));
    }
}
