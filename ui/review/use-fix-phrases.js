import { useEffect, useMemo, useState } from "react";
import { ui, uiFormat } from "../i18n.js";
import { useToast } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { useUndoable } from "../use-undoable.js";
import { addFixPhrase, removeFixPhrase } from "../../lib/fix-phrases.js";
import { resolvePracticeSettings } from "../../lib/practice-settings.js";

/* The learner's own 修题 phrases (lib/fix-phrases.js) as the box needs them: the saved list, `add(text)` and `remove(phrase)`. They are the library's setting
   (settings.practice.fixPhrases, the existing settings.practice.set), so they follow the learner to another device. What was just chosen shows at once, until the
   library says the same. A removal offers 撤销, which writes the list back as it was. */
const clip = (text) => ([...text].length > 20 ? `${[...text].slice(0, 20).join("")}…` : text);

export function useFixPhrases(data) {
  const { act } = useStudy();
  const toast = useToast();
  const undoable = useUndoable();
  const savedKey = JSON.stringify(resolvePracticeSettings(data?.settings?.practice).fixPhrases || []);
  const saved = useMemo(() => JSON.parse(savedKey), [savedKey]);
  const [choice, setChoice] = useState(null);
  useEffect(() => { if (choice !== null && JSON.stringify(choice) === savedKey) setChoice(null); }, [savedKey, choice]);
  const phrases = choice ?? saved;

  // true: saved; undefined: another write held the lock, nothing was saved; false: the library refused (the toast says why).
  const write = async (next) => {
    setChoice(next);
    try {
      const result = await act("settings.practice.set", { patch: { fixPhrases: next } }, undefined, { rethrow: true });
      if (result === undefined) setChoice(null);
      return result === undefined ? undefined : true;
    } catch (cause) { setChoice(null); toast.error(cause); return false; }
  };
  const add = async (text) => {
    if (addFixPhrase(phrases, text) === phrases) return;
    if (await write(addFixPhrase(phrases, text))) toast.success(ui("已存为我的常用语句"));
  };
  const remove = async (phrase) => {
    const before = phrases;
    if (await write(removeFixPhrase(before, phrase)))
      undoable.restoreWith({ message: uiFormat("已删除常用语句「{0}」", [clip(phrase)]), restored: ui("已恢复这条常用语句"), restore: () => write(before) });
  };
  return { phrases, add, remove };
}
