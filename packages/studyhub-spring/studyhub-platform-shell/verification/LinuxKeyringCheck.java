import io.studyhub.platform.linux.KeyringSecrets;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.UUID;

/** Run inside a disposable, unlocked D-Bus Secret Service session. */
class LinuxKeyringCheck {
    public static void main(String[] args) throws Exception {
        var store = new KeyringSecrets(Path.of(args[0]));
        String key = "verification/" + UUID.randomUUID();
        byte[] input = "test data 课程".getBytes(StandardCharsets.UTF_8);
        if (store.read(key).isPresent()) throw new AssertionError("Unexpected existing key");
        try {
            store.write(key, input);
            if (!Arrays.equals(input, store.read(key).orElseThrow())) throw new AssertionError("Wrong value");
        } finally { store.delete(key); }
        if (store.read(key).isPresent()) throw new AssertionError("Delete failed");
        System.out.println("libsecret write / reopen / delete passed");
    }
}
