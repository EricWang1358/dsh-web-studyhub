package io.studyhub.platform;

import io.studyhub.platform.linux.EncryptedSecrets;
import io.studyhub.platform.linux.LinuxPaths;
import io.studyhub.platform.spi.SecretStore;
import io.studyhub.platform.windows.DpapiSecrets;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class SecretStoreTest {
    @TempDir Path directory;

    @Test @EnabledOnOs(OS.WINDOWS)
    void dpapiUsesTheActualLoggedInWindowsAccount() throws Exception {
        roundTrip(new DpapiSecrets(directory), new DpapiSecrets(directory));
    }

    @Test void headlessStoreAuthenticatesItsFormatAndPassword() throws Exception {
        try (var first = new EncryptedSecrets(directory, "demo password".toCharArray());
             var reopened = new EncryptedSecrets(directory, "demo password".toCharArray());
             var wrong = new EncryptedSecrets(directory, "other password".toCharArray())) {
            first.write("model", new byte[]{0, 1, 2});
            assertThrows(IOException.class, () -> wrong.read("model"));
            first.delete("model");
            roundTrip(first, reopened);
        }
    }

    private void roundTrip(SecretStore store, SecretStore reopened) throws Exception {
        String key = "provider/课程";
        byte[] clear = "sample provider credential".getBytes(StandardCharsets.UTF_8);
        assertTrue(store.read(key).isEmpty());
        store.write(key, new byte[]{1});
        store.write(key, clear);
        assertArrayEquals(clear, reopened.read(key).orElseThrow());
        Path entry;
        try (var files = Files.list(directory)) { entry = files.findFirst().orElseThrow(); }
        byte[] sealed = Files.readAllBytes(entry);
        assertFalse(new String(sealed, StandardCharsets.ISO_8859_1).contains("sample provider"));
        sealed[sealed.length - 1] ^= 1;
        Files.write(entry, sealed);
        assertThrows(IOException.class, () -> reopened.read(key));
        store.delete(key);
        assertTrue(reopened.read(key).isEmpty());
    }

    @Test void xdgUsesOnlyAbsoluteOverrides() {
        var paths = LinuxPaths.from(Map.of("XDG_CONFIG_HOME", "relative", "XDG_DATA_HOME", directory.toString()), directory);
        assertEquals(directory.resolve("studyhub"), paths.data());
        assertEquals(directory.resolve(".config/studyhub"), paths.config());
    }
}
