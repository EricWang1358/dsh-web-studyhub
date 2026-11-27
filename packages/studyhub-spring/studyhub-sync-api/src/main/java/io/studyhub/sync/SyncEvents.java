package io.studyhub.sync;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.*;
import org.springframework.web.socket.config.annotation.*;
import org.springframework.web.socket.handler.*;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

@Configuration
@EnableWebSocket
class SyncEvents extends TextWebSocketHandler implements WebSocketConfigurer {
    private final ConcurrentMap<String, Subscriber> subscribers = new ConcurrentHashMap<>();
    private record Subscriber(UUID vault, WebSocketSession session) {}
    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(this, "/sync/v1/vaults/*/events");
    }
    @Override public void afterConnectionEstablished(WebSocketSession raw) throws Exception {
        String[] path = raw.getUri().getPath().split("/");
        UUID vault;
        try { vault = UUID.fromString(path[path.length-2]); }
        catch (IllegalArgumentException e) { raw.close(CloseStatus.BAD_DATA); return; }
        var session = new ConcurrentWebSocketSessionDecorator(raw, 5000, 4096);
        subscribers.put(raw.getId(), new Subscriber(vault,session));
        session.sendMessage(new TextMessage("ready"));
    }
    @Override public void afterConnectionClosed(WebSocketSession raw, CloseStatus reason) {
        subscribers.remove(raw.getId());
    }
    void published(UUID vault, long seq) {
        var message = new TextMessage(Long.toString(seq));
        subscribers.forEach((id, sub) -> {
            if (!sub.vault.equals(vault)) return;
            try { sub.session.sendMessage(message); }
            catch (IOException | IllegalStateException e) {
                subscribers.remove(id,sub);
                try { sub.session.close(); } catch (IOException ignored) { /* peer closed */ }
            }
        });
    }
}
