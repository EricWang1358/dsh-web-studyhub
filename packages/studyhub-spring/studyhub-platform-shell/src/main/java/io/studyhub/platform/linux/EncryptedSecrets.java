package io.studyhub.platform.linux;

import io.studyhub.platform.vault.FileSecrets;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

public final class EncryptedSecrets extends FileSecrets implements AutoCloseable {
    private static final int FORMAT = 1;
    private static final int ITERATIONS = 600_000;
    private static final SecureRandom RANDOM = new SecureRandom();
    private final char[] password;

    public EncryptedSecrets(Path directory, char[] password) {
        super(directory);
        this.password = password.clone();
    }

    @Override protected byte[] transform(String key, byte[] input, boolean encrypt) throws IOException {
        if (password.length == 0) throw new IOException("Set STUDYHUB_KEYSTORE_PASSWORD to use the headless secret store");
        byte[] salt = new byte[16], iv = new byte[12];
        ByteBuffer frame = ByteBuffer.wrap(input);
        if (encrypt) { RANDOM.nextBytes(salt); RANDOM.nextBytes(iv); }
        else {
            if (frame.remaining() < 1 + salt.length + iv.length + 16 || frame.get() != FORMAT)
                throw new IOException("Invalid or unsupported secret format");
            frame.get(salt).get(iv);
        }
        var spec = new PBEKeySpec(password, salt, ITERATIONS, 256);
        try {
            byte[] derived = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(encrypt ? Cipher.ENCRYPT_MODE : Cipher.DECRYPT_MODE, new SecretKeySpec(derived, "AES"),
                        new GCMParameterSpec(128, iv));
                cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
                byte[] output = cipher.doFinal(input, frame.position(), frame.remaining());
                return encrypt ? ByteBuffer.allocate(1 + salt.length + iv.length + output.length)
                        .put((byte) FORMAT).put(salt).put(iv).put(output).array() : output;
            } finally { Arrays.fill(derived, (byte) 0); }
        } catch (GeneralSecurityException failure) {
            throw new IOException("Unable to encrypt or authenticate secret", failure);
        } finally { spec.clearPassword(); }
    }

    @Override public void close() { Arrays.fill(password, '\0'); }
}
