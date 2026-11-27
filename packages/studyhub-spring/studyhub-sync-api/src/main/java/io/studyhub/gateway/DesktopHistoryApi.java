package io.studyhub.gateway;

import io.studyhub.sync.DesktopReviewHistory;
import jakarta.servlet.http.HttpServletResponse;
import java.util.*;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

/** A remote revision is inspected separately from the local Node-owned run, feedback and schedule. */
@RestController
@ConditionalOnProperty(name = "studyhub.desktop-history.enabled", havingValue = "true")
@RequestMapping("/api/sync/desktop-history")
final class DesktopHistoryApi {
    private final DesktopHistorySync sync;
    DesktopHistoryApi(DesktopHistorySync sync) { this.sync = sync; }

    @GetMapping("/status")
    DesktopHistorySync.Status status() { return sync.status(); }

    @GetMapping
    DesktopReviewHistory.Page list(@RequestParam(defaultValue="0") long after,
                                   @RequestParam(defaultValue="64") int limit) throws Exception {
        try { return sync.history.page(after, limit); }
        catch (IllegalArgumentException invalid) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid page"); }
    }

    @GetMapping(value="/{id}", produces=MediaType.APPLICATION_JSON_VALUE)
    void read(@PathVariable UUID id, HttpServletResponse response) throws Exception {
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader("Cache-Control", "no-store");
        try { sync.history.read(id, response.getOutputStream()); }
        catch (NoSuchElementException absent) { throw new ResponseStatusException(HttpStatus.NOT_FOUND); }
    }
}
