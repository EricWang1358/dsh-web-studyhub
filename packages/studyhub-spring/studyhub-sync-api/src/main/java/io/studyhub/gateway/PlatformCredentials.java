package io.studyhub.gateway;

import io.studyhub.ai.ProviderSecrets;
import io.studyhub.platform.spi.SecretStore;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/ai/credentials")
final class PlatformCredentials implements ProviderSecrets {
    private final SecretStore secrets;

    PlatformCredentials(SecretStore secrets) { this.secrets = secrets; }

    @Override public String resolve(String name) {
        String value = System.getenv(name);
        if (value != null && !value.isBlank()) return value;
        try { return secrets.read(name).map(bytes -> {
            try { return new String(bytes, StandardCharsets.UTF_8); }
            finally { Arrays.fill(bytes, (byte) 0); }
        }).orElse(null); }
        catch (IOException failure) { throw new UncheckedIOException("Could not read the provider credential", failure); }
    }

    @PutMapping(path = "/{name}", consumes = "text/plain")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void store(@PathVariable String name, HttpServletRequest request) throws IOException {
        requireName(name);
        byte[] value = request.getInputStream().readNBytes(8193);
        try {
            if (value.length == 0 || value.length > 8192)
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Expected a credential of 1 to 8192 bytes");
            secrets.write(name, value);
        } finally { Arrays.fill(value, (byte) 0); }
    }

    @DeleteMapping("/{name}") @ResponseStatus(HttpStatus.NO_CONTENT)
    void remove(@PathVariable String name) throws IOException {
        requireName(name);
        secrets.delete(name);
    }

    private void requireName(String name) {
        if (!name.matches("[A-Za-z_][A-Za-z0-9_]{0,127}"))
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid credential name");
    }
}
