import { optionMark } from './option-label.js';

/** What stands in the round before an option (ui/option-label.js optionMark): its letter, or for a fixed option (判断题) its number. */
export default function OptionMark({ card, option, index }) {
  return optionMark(card, option, index);
}
