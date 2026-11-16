import { fixedOptionLabel, optionMark } from './option-label.js';

/** What stands in the round before an option: for a fixed option (判断题) its own word, shortened to its first character (对 / 错, T / F); else its letter ("A", or "A." with `dot`).
    Never a tick or a cross: those are the verdict's (AnswerState) and would say "right" / "wrong" about the option, not "the option is 对". */
export default function OptionMark({ card, option, index, dot = false }) {
  const word = fixedOptionLabel(card, option);
  if (word) return [...word][0];
  const letter = optionMark(card, option, index);
  return dot ? `${letter}.` : letter;
}
