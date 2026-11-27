package io.studyhub.gateway;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.InetAddress;
import java.util.Map;
import java.util.Set;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
final class LocalRequestFilter extends OncePerRequestFilter {
    private static final Set<String> TAURI_ORIGINS = Set.of(
            "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost");
    private final LoopbackSession session;
    private final ObjectMapper json;

    LocalRequestFilter(LoopbackSession session, ObjectMapper json) {
        this.session = session;
        this.json = json;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        int port = request.getLocalPort();
        String host = request.getHeader("Host");
        String origin = request.getHeader("Origin");
        if (!InetAddress.getByName(request.getRemoteAddr()).isLoopbackAddress() || !validHost(host, port)) {
            forbidden(response, "Forbidden host", "forbidden-host");
            return;
        }
        if (origin != null && !origin.isEmpty()) {
            if (!validOrigin(origin, port)) {
                forbidden(response, "Forbidden origin", "forbidden-origin");
                return;
            }
            response.setHeader("Access-Control-Allow-Origin", origin);
            response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Study-Token");
            response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            response.addHeader("Vary", "Origin");
        }
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
        if ("OPTIONS".equals(request.getMethod())
                && Set.of("/api/call", "/api/events").contains(request.getServletPath())) {
            response.setStatus(HttpServletResponse.SC_NO_CONTENT);
            return;
        }
        chain.doFilter(request, response);
    }

    // Check the token at the mapped controller, after the servlet container has resolved the URL.
    boolean authorize(HttpServletRequest request, HttpServletResponse response) throws IOException {
        if (session.accepts(request.getHeader(LoopbackSession.HEADER))) return true;
        forbidden(response, "Forbidden", "forbidden");
        return false;
    }

    private static boolean validHost(String host, int port) {
        return ("127.0.0.1:" + port).equalsIgnoreCase(host)
                || ("localhost:" + port).equalsIgnoreCase(host)
                || ("[::1]:" + port).equalsIgnoreCase(host);
    }

    private static boolean validOrigin(String origin, int port) {
        return TAURI_ORIGINS.contains(origin) || origin.equals("http://localhost:" + port)
                || origin.equals("http://127.0.0.1:" + port);
    }

    private void forbidden(HttpServletResponse response, String message, String code) throws IOException {
        response.setStatus(HttpServletResponse.SC_FORBIDDEN);
        response.setContentType("application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        json.writeValue(response.getOutputStream(), Map.of("ok", false, "error", message, "code", code));
    }
}
