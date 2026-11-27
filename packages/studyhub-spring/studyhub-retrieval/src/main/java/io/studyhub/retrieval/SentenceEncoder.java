package io.studyhub.retrieval;

import java.io.IOException;

public interface SentenceEncoder {
    /** Changes whenever model weights, tokenization or pooling change. */
    String identity();
    int dimensions();
    float[] encode(String text) throws IOException;
}
