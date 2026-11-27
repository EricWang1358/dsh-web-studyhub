package io.studyhub.platform.linux;

import io.studyhub.platform.spi.SecretStore;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** secret-tool uses the desktop session's libsecret service. Secret values travel on pipes. */
public final class KeyringSecrets implements SecretStore {
    private final Path executable;

    public KeyringSecrets(Path executable) { this.executable = executable; }

    @Override public Optional<byte[]> read(String key) throws IOException {
        var result = invoke(List.of("lookup"), key, null);
        if (result.absent()) return Optional.empty();
        result.requireSuccess();
        return Optional.of(Base64.getDecoder().decode(result.output.strip()));
    }

    @Override public void write(String key, byte[] value) throws IOException {
        invoke(List.of("store", "--label=StudyHub"), key, Base64.getEncoder().encode(value)).requireSuccess();
    }

    @Override public void delete(String key) throws IOException {
        var result = invoke(List.of("clear"), key, null);
        if (!result.absent()) result.requireSuccess();
    }

    private record Result(int status, String output) {
        boolean absent() { return status == 1 && output.isBlank(); }
        void requireSuccess() throws IOException {
            if (status != 0) throw new IOException("Desktop keyring exited with code " + status);
        }
    }

    private Result invoke(List<String> operation, String key, byte[] input) throws IOException {
        List<String> command = new ArrayList<>(List.of(executable.toString()));
        command.addAll(operation);
        command.addAll(List.of("application", "studyhub", "key", key));
        Process process = new ProcessBuilder(command).redirectErrorStream(true).start();
        var result = new CompletableFuture<String>();
        Thread.startVirtualThread(() -> {
            try (var out = process.getInputStream()) {
                result.complete(new String(out.readAllBytes(), StandardCharsets.US_ASCII));
            } catch (IOException error) { result.completeExceptionally(error); }
        });
        try {
            try (var stdin = process.getOutputStream()) { if (input != null) stdin.write(input); }
            if (!process.waitFor(20, TimeUnit.SECONDS)) throw new IOException("Timed out waiting for desktop keyring");
            return new Result(process.exitValue(), result.get(2, TimeUnit.SECONDS));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted waiting for desktop keyring", interrupted);
        } catch (java.util.concurrent.ExecutionException | java.util.concurrent.TimeoutException failure) {
            throw new IOException("Could not read desktop keyring response", failure);
        } finally { if (process.isAlive()) process.destroyForcibly(); }
    }
}
