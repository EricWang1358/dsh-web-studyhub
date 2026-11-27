package io.studyhub.sync;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.*;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
final class SyncAuth extends OncePerRequestFilter {
    private final byte[] digest;
    SyncAuth(@Value("${studyhub.sync.token:}") String token) {
        if (token.length() < 32 || !token.equals(token.strip()))
            throw new IllegalArgumentException("Supply a private STUDYHUB_SYNC_TOKEN of at least 32 characters");
        this.digest = hash("Bearer " + token);
    }
    private static byte[] hash(String input) {
        try { return MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)); }
        catch (NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    @Override protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
        throws IOException, ServletException {
        if (req.getRequestURI().equals(req.getContextPath() + "/actuator/health") && req.getMethod().equals("GET")) {
            chain.doFilter(req, res); return;
        }
        String auth = req.getHeader("Authorization");
        if (auth == null || !MessageDigest.isEqual(digest, hash(auth))) {
            res.setHeader("WWW-Authenticate","Bearer"); res.setStatus(401); return;
        }
        chain.doFilter(req,res);
    }
}
