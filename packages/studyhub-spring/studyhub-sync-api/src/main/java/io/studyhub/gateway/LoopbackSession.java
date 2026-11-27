package io.studyhub.gateway;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import org.springframework.stereotype.Component;

@Component
final class LoopbackSession {
    static final String HEADER = "X-Study-Token";
    private final String token = newToken();

    static String newToken() {
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        return HexFormat.of().formatHex(secret);
    }

    String browserToken() {
        return token;
    }

    boolean accepts(String candidate) {
        return candidate != null && MessageDigest.isEqual(
                token.getBytes(StandardCharsets.US_ASCII), candidate.getBytes(StandardCharsets.UTF_8));
    }
}
