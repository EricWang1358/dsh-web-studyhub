import React from 'react';
import { Icon } from './components/index.js';
import { optionIcon, optionMark } from './option-label.js';

/** What stands in the round before an option: a registry icon for a fixed option (the tick and cross of 对 / 错), else its letter ("A", or "A." with `dot`). */
export default function OptionMark({ card, option, index, dot = false }) {
  const icon = optionIcon(card, option);
  if (icon) return <Icon name={icon} size={16} />;
  const letter = optionMark(card, option, index);
  return dot ? `${letter}.` : letter;
}
