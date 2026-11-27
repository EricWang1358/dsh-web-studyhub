package io.studyhub.sync;

import javax.crypto.*;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;

/** AEAD keys stay on clients. The relay sees opaque vault/operation IDs, packet sizes and arrival order. */
public final class Packets {
    public static final int MAX_BYTES = 65536;
    private static final SecureRandom RANDOM = new SecureRandom();
    private Packets() {}
    static String sha256(byte[] bytes) {
        try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (NoSuchAlgorithmException unavailable) { throw new IllegalStateException(unavailable); }
    }
    static void check(byte[] packet) {
        if (packet.length < 29 || packet.length > MAX_BYTES || packet[0] != 1)
            throw new IllegalArgumentException("Unsupported or malformed encrypted packet");
    }
    public static SecretKey key(byte[] bytes) {
        if (bytes.length != 32) throw new IllegalArgumentException("Expected a 256-bit sync key");
        return new SecretKeySpec(bytes, "AES");
    }
    public static byte[] encrypt(SecretKey key, UUID vault, UUID id, byte[] plaintext) throws GeneralSecurityException {
        if (plaintext.length > MAX_BYTES - 29) throw new IllegalArgumentException("Operation too large");
        byte[] nonce = new byte[12]; RANDOM.nextBytes(nonce);
        Cipher cipher = cipher(Cipher.ENCRYPT_MODE, key, vault, id, nonce);
        return ByteBuffer.allocate(29 + plaintext.length).put((byte)1).put(nonce).put(cipher.doFinal(plaintext)).array();
    }
    public static byte[] decrypt(SecretKey key, UUID vault, UUID id, byte[] packet) throws GeneralSecurityException {
        check(packet);
        Cipher cipher = cipher(Cipher.DECRYPT_MODE, key, vault, id, Arrays.copyOfRange(packet, 1, 13));
        return cipher.doFinal(packet, 13, packet.length - 13);
    }
    private static Cipher cipher(int mode, SecretKey key, UUID vault, UUID id, byte[] nonce) throws GeneralSecurityException {
        if (key.getEncoded() == null || key.getEncoded().length != 32) throw new InvalidKeyException("Expected AES-256 key");
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(mode, key, new GCMParameterSpec(128, nonce));
        c.updateAAD(("studyhub-sync/v1/" + vault + "/" + id).getBytes(StandardCharsets.US_ASCII));
        return c;
    }
}
