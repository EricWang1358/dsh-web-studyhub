package io.studyhub.platform.windows;

import io.studyhub.platform.vault.FileSecrets;
import java.io.IOException;
import java.lang.foreign.*;
import java.lang.invoke.MethodHandle;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import static java.lang.foreign.ValueLayout.*;

public final class DpapiSecrets extends FileSecrets {
    public DpapiSecrets(Path directory) { super(directory); }

    private static final long POINTER_OFFSET = ADDRESS.byteSize();
    private static final int FORBID_UI = 1;
    private static final FunctionDescriptor DPAPI = FunctionDescriptor.of(JAVA_INT, ADDRESS, ADDRESS,
            ADDRESS, ADDRESS, ADDRESS, JAVA_INT, ADDRESS);

    @Override protected byte[] transform(String key, byte[] input, boolean encrypt) throws IOException {
        try (Arena arena = Arena.ofConfined()) {
            var linker = Linker.nativeLinker();
            var crypt = SymbolLookup.libraryLookup("Crypt32", arena);
            var kernel = SymbolLookup.libraryLookup("Kernel32", arena);
            MethodHandle call = linker.downcallHandle(crypt.find(encrypt ? "CryptProtectData" : "CryptUnprotectData").orElseThrow(), DPAPI);
            MethodHandle release = linker.downcallHandle(kernel.find("LocalFree").orElseThrow(),
                    FunctionDescriptor.of(ADDRESS, ADDRESS));
            MemorySegment source = blob(arena, input);
            MemorySegment entropy = blob(arena, key.getBytes(StandardCharsets.UTF_8));
            MemorySegment output = arena.allocate(2 * POINTER_OFFSET, POINTER_OFFSET);
            try {
                int ok = (int) call.invokeExact(source, MemorySegment.NULL, entropy,
                        MemorySegment.NULL, MemorySegment.NULL, FORBID_UI, output);
                if (ok == 0) throw new IOException("Windows DPAPI operation failed");
                MemorySegment pointer = output.get(ADDRESS, POINTER_OFFSET);
                int size = output.get(JAVA_INT, 0);
                try {
                    MemorySegment bytes = pointer.reinterpret(Integer.toUnsignedLong(size));
                    try { return bytes.toArray(JAVA_BYTE); }
                    finally { if (!encrypt) bytes.fill((byte) 0); }
                } finally {
                    MemorySegment unused = (MemorySegment) release.invokeExact(pointer);
                }
            } finally {
                if (encrypt) source.get(ADDRESS, POINTER_OFFSET).reinterpret(input.length).fill((byte) 0);
            }
        } catch (IOException failure) {
            throw failure;
        } catch (Throwable failure) {
            if (failure instanceof Error fatal) throw fatal;
            throw new IOException("Could not invoke Windows DPAPI", failure);
        }
    }

    private static MemorySegment blob(Arena arena, byte[] input) {
        MemorySegment bytes = arena.allocate(Math.max(1, input.length));
        bytes.asSlice(0, input.length).copyFrom(MemorySegment.ofArray(input));
        MemorySegment blob = arena.allocate(2 * POINTER_OFFSET, POINTER_OFFSET);
        blob.set(JAVA_INT, 0, input.length);
        blob.set(ADDRESS, POINTER_OFFSET, bytes);
        return blob;
    }
}
