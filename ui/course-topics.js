/* A course's focus topics as the panel keeps them: one string, topics separated by "; " (what course.save splits again). The chips of ui/TopicChips.jsx add and remove
   topics through these, so what the box accepts (; ； , ， and new lines) and what a list looks like stay in one place. */

/** The topics of a text: split on ; ； and new lines (a comma stays inside a topic: "Trade-offs, risks" is one), trimmed, no empty ones, no repeats. */
export const splitTopics = value => [...new Set(String(value || '').split(/[;；\n]/).map(item => item.trim()).filter(Boolean))];

const join = topics => topics.join('; ');

/** `value` with the topics of `text` added at the end (the ones it has already are not added twice). */
export const addTopics = (value, text) => join(splitTopics(`${value || ''};${text || ''}`));

/** `value` without `topic`. */
export const removeTopic = (value, topic) => join(splitTopics(value).filter(item => item !== topic));
