export const validLanguage = language => language === 'en' || language === 'zh';
export function languageSystem(system, language) {
  if (!validLanguage(language)) return system;
  const target = language === 'en' ? 'English' : 'Chinese';
  const revised = language === 'en' ? system.replaceAll('Chinese tutor','tutor').replaceAll('short Chinese name','short English name').replaceAll('Chinese learning article','learning article').replaceAll('用中文回答','Answer in English').replaceAll('中文陪学助教','学习助教') : system;
  return revised + `\n\nApplication language preference: ${target}. Write NEW learner-facing explanations, guidance, follow-up suggestions, session titles and feedback in ${target}. This overrides generic language defaults above. Do not translate or rewrite existing question prompts, answers, options, source text, verbatim quotations, code, identifiers or saved learner content merely because the interface language changed. For a NEW question/deck, honor its explicit requested content language independently. For an explicit translation task, honor its target language. Keep JSON keys, schema enums and machine-readable values exactly as specified; localize only human-facing prose.`;
}
