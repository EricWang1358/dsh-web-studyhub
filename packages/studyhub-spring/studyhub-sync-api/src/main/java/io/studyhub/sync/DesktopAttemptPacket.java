package io.studyhub.sync;

import io.studyhub.domain.sync.StudyOp;
import java.io.IOException;
import java.util.UUID;

/** Encrypted revision envelope. Grade semantics and desktop record fields remain owned by the issuing Node library. */
record DesktopAttemptPacket(String source, UUID previous, String inline, EncryptedBlobTree.Manifest blob) {
    DesktopAttemptPacket {
        if (source == null || !source.matches("[0-9a-f]{64}") || (inline == null) == (blob == null))
            throw new IllegalArgumentException("Invalid desktop revision");
    }

    static DesktopAttemptPacket decode(StudyOp op) throws IOException {
        return SyncReplica.JSON.readValue(op.value(), DesktopAttemptPacket.class);
    }
}
