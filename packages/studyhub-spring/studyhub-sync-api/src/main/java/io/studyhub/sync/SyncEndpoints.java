package io.studyhub.sync;

import io.studyhub.storage.BlobStore;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import java.io.*;
import java.nio.file.*;
import java.security.*;
import java.sql.SQLException;
import java.util.*;

@RestController
@RequestMapping("/sync/v1/vaults/{vault}")
final class SyncEndpoints {
    private final PacketJournal journal;
    private final SyncEvents events;
    private final Path chunkRoot;

    SyncEndpoints(PacketJournal journal, SyncEvents events, @Value("${studyhub.sync.data-dir:${STUDYHUB_SYNC_DATA_DIR:./studyhub-sync-data}}") Path dir) {
        this.journal = journal; this.events = events; this.chunkRoot = dir.resolve("chunks");
    }
    @PutMapping(value="/ops/{id}", consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public PacketJournal.Append append(@PathVariable UUID vault, @PathVariable UUID id, HttpServletRequest req) throws Exception {
        var row = journal.append(vault,id,body(req));
        if (row.inserted()) events.published(vault,row.seq());
        return row;
    }
    @GetMapping("/ops")
    public List<PacketJournal.Packet> page(@PathVariable UUID vault, @RequestParam(defaultValue="0") long after,
                                          @RequestParam(defaultValue="32") int limit) throws SQLException {
        return journal.page(vault,after,limit,false);
    }
    private static byte[] body(HttpServletRequest req) throws IOException {
        if (req.getContentLengthLong() > Packets.MAX_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
        byte[] bytes = req.getInputStream().readNBytes(Packets.MAX_BYTES+1);
        if (bytes.length > Packets.MAX_BYTES) throw new ResponseStatusException(HttpStatus.PAYLOAD_TOO_LARGE);
        Packets.check(bytes);
        return bytes;
    }
    private Path chunk(UUID vault, String hash) {
        if (!hash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Invalid chunk digest");
        return chunkRoot.resolve(vault.toString()).resolve(hash);
    }
    @PutMapping(value="/chunks/{digest}", consumes=MediaType.APPLICATION_OCTET_STREAM_VALUE)
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void upload(@PathVariable UUID vault, @PathVariable String digest, HttpServletRequest req) throws IOException {
        Path file = chunk(vault,digest);
        byte[] bytes = body(req);
        if (!digest.equals(Packets.sha256(bytes))) throw new IllegalArgumentException("Chunk checksum mismatch");
        new BlobStore(file.getParent()).put(new ByteArrayInputStream(bytes));
    }
    @RequestMapping(value="/chunks/{digest}", method=RequestMethod.HEAD)
    public ResponseEntity<Void> exists(@PathVariable UUID vault, @PathVariable String digest) {
        return ResponseEntity.status(Files.isRegularFile(chunk(vault,digest)) ? 200 : 404).build();
    }
    @GetMapping(value="/chunks/{digest}", produces=MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public byte[] download(@PathVariable UUID vault, @PathVariable String digest) throws IOException {
        try { return Files.readAllBytes(chunk(vault,digest)); }
        catch (NoSuchFileException e) { throw new ResponseStatusException(HttpStatus.NOT_FOUND); }
    }
    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public void invalidPacket() {}
    @ExceptionHandler(ConcurrentModificationException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public void conflictingPacket() {}
}
