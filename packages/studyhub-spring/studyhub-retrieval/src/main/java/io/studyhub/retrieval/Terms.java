package io.studyhub.retrieval;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

final class Terms {
    private Terms() { }

    // FTS5 unicode61 keeps adjacent Han characters in one word. Add each CJK character and its
    // adjacent bigram as separate terms so a phrase can match the middle of an unspaced sentence.
    static List<String> split(String text) {
        String normalized = Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        List<String> terms = new ArrayList<>();
        StringBuilder word = new StringBuilder();
        String previous = "";
        for (int i = 0; i < normalized.length(); ) {
            int cp = normalized.codePointAt(i);
            i += Character.charCount(cp);
            var script = Character.UnicodeScript.of(cp);
            if (script == Character.UnicodeScript.HAN || script == Character.UnicodeScript.HIRAGANA
                    || script == Character.UnicodeScript.KATAKANA || script == Character.UnicodeScript.HANGUL) {
                flush(word, terms);
                String character = Character.toString(cp);
                terms.add(character);
                if (!previous.isEmpty()) terms.add(previous + character);
                previous = character;
            } else {
                previous = "";
                if (Character.isLetterOrDigit(cp)) word.appendCodePoint(cp);
                else flush(word, terms);
            }
        }
        flush(word, terms);
        return terms;
    }

    private static void flush(StringBuilder word, List<String> terms) {
        if (!word.isEmpty()) {
            terms.add(word.toString());
            word.setLength(0);
        }
    }

    static String match(String query) {
        return split(query).stream().distinct().limit(128).map(term -> "\"" + term + "\"")
                .collect(Collectors.joining(" OR "));
    }
}
