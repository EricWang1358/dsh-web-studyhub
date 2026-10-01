import english from './application-messages-en.js';

const templates = [
  [/^这个检索工具需要一个 StudyHub 填不了的参数「(.+)」，请在设置里换一个工具。$/, (_, name) => `This retrieval tool needs an argument StudyHub cannot fill in (“${name}”); choose another tool in Settings.`],
  [/^已选择的检索工具「(.+)」现在找不到。请确认它在 DSH 里已启用，或到设置里换一个。$/, (_, name) => `The retrieval tool “${name}” cannot be found now. Check that it is enabled in DSH, or choose another in Settings.`],
  [/^(.+) 现在找不到。请确认它在 DSH 里已启用后再选。$/, (_, name) => `${name} cannot be found now. Check that it is enabled in DSH before choosing it.`],
  [/^所选资料有 ([\d,]+) 个字符，超过一次能处理的上限。请在「这次想练什么？」写下主题，StudyHub 会用检索挑出相关页面；也可以按章节缩小选择。$/, (_, chars) => `The selected material has ${chars} characters, over what one generation accepts. Write a topic under “What do you want to practise?” so StudyHub can pick the relevant pages by search, or narrow the selection by chapter.`],
  [/^(免费密钥|付费密钥|Groq 密钥|硅基流动密钥|密钥)(?:被拒绝（(\d+)）：([\s\S]+))$/, (_, key, status, evidence) => `${keyName(key)} rejected (${status}): ${evidence === '没有权限' ? 'Permission denied' : evidence}`],
  [/^(免费密钥|付费密钥|Groq 密钥|硅基流动密钥|密钥)无效，请重新复制 AI Studio 里的密钥$/, (_, key) => `${keyName(key)} is invalid; copy the key from AI Studio again`],
  [/^(免费密钥|付费密钥|Groq 密钥|硅基流动密钥|密钥)额度被限流（(每日|每分钟)额度用完）$/, (_, key, scope) => `${keyName(key)} rate limited (${scope === '每日' ? 'daily' : 'per-minute'} quota exhausted)`],
  [/^免费额度今日用完，其余请求改用(.+)$/, (_, key) => `Free daily quota exhausted; remaining requests use ${fallbackKey(key)}`],
  [/^免费额度被限流，部分请求改用(.+)$/, (_, key) => `Free quota rate limited; some requests use ${fallbackKey(key)}`],
  [/^(Groq|硅基流动) 额度被限流，这一步改用(.+)$/, (_, provider, key) => `${providerName(provider)} rate limited; this step uses ${fallbackKey(key)}`],
  [/^(Groq|硅基流动) 没能完成这一步（([\s\S]+)），改用(.+)$/, (_, provider, evidence, key) => `${providerName(provider)} could not complete this step (${localizeAppMessage(evidence)}); using ${fallbackKey(key)}`],
  [/^([\s\S]+)；改用( Groq|付费密钥| 硅基流动)$/, (_, evidence, key) => `${localizeAppMessage(evidence)}; using ${fallbackKey(key)}`],
  [/^(Groq |硅基流动)超过 (\d+) 分钟没有回应$/, (_, provider, minutes) => `${providerName(provider.trim())} did not respond within ${minutes} minute(s)`],
  [/^连不上(?: Groq |硅基流动)服务：([\s\S]+)$/, (match, evidence) => `Unable to connect to ${match.includes('Groq') ? 'Groq' : 'SiliconFlow'}: ${evidence === '网络错误' ? 'Network error' : evidence}`],
  [/^(.+) 超过 (Groq|硅基流动) 的 (.+) 限制，要切开需要 ffmpeg（这台电脑上没有找到），这一步先交给下一档$/, (_, label, provider, limit) => `${label} exceeds the ${limit} limit of ${providerName(provider)}; cutting it needs ffmpeg, which is not installed on this computer. The next provider takes this step`],
  [/^(.+) 不是 (Groq|硅基流动) 能直接读的格式，要转换需要 ffmpeg（这台电脑上没有找到），这一步先交给下一档$/, (_, label, provider) => `${label} is not a format ${providerName(provider)} reads directly; converting it needs ffmpeg, which is not installed on this computer. The next provider takes this step`],
  [/^这段 (WAV|MP3) 切不到 (Groq|硅基流动) 的文件大小限制以内$/, (_, kind, provider) => `This ${kind} cannot be cut below the ${providerName(provider)} file size limit`],
  [/^ffmpeg 切出的一段仍超过 (Groq|硅基流动) 的文件大小限制$/, (_, provider) => `A segment produced by ffmpeg still exceeds the ${providerName(provider)} file size limit`],
  [/^读不懂这份 M4A 文件的结构（([\s\S]+)），可能不完整或已损坏$/, (_, detail) => `This M4A file's structure cannot be read (${detail}); it may be incomplete or damaged`],
  [/^这份 M4A 约 (\d+) 分钟，超过单次转写的 1 小时上限，但它的内部结构不能在本地无损切分（([\s\S]+)）。请在录音软件里另存为 MP3 后再导入$/, (_, minutes, reason) => `This M4A is about ${minutes} minutes, above the one-hour transcription limit, and its structure cannot be split losslessly here (${localizeAppMessage(reason)}). Save it as MP3 in your recording app and import it again`],
  [/^「(.+)」未通过预检，其余文件尚未开始；可以跳过它继续$/, (_, filename) => `"${filename}" did not pass the pre-flight check; the other files have not started. You can skip it and continue`],
  [/^第 (\d+) 部分的小标题没有生成，已用文件名代替$/, (_, part) => `No heading was generated for part ${part}; the file name is used instead`],
  [/^连不上 Google 服务：([\s\S]+)。请检查网络；需要代理时，用 NODE_USE_ENV_PROXY=1 和 HTTPS_PROXY 启动 DSH$/, (_, evidence) => `Unable to connect to Google: ${evidence === '网络错误' ? 'Network error' : evidence}. Check the network. If a proxy is needed, start DSH with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY`],
  [/^Google 超过 (\d+) 分钟没有回应（等待时间已按这一段的长度和大小放宽，并自动重试过一次）。可以在「设置 › 音频转写 › 高级」里把「每次请求最长」调小后重试；已经转写好的段落有缓存，不会重复转写$/, (_, minutes) => `Google did not respond within ${minutes} minute(s), despite a length-adjusted deadline and one automatic retry. Reduce Maximum minutes per request in Settings › Audio transcription › Advanced and retry. Completed segments are cached and will not be transcribed again`],
  [/^模型不存在或此密钥不可用：([\s\S]*)$/, (_, evidence) => `The model does not exist or is unavailable to this key: ${evidence}`],
  [/^(Groq|Gemini|硅基流动) 请求失败（([^)）]+)）：([\s\S]+?)(?:（涉及字段 ([\s\S]+)）)?$/, (_, provider, status, evidence, fields) => `${providerName(provider)} request failed (${status}): ${evidence === '没有返回原因' ? 'No reason returned' : evidence}${fields ? ` (affected fields: ${fields})` : ''}`],
  [/^(.+) 暂时不可用：([\s\S]+)$/, (_, label, evidence) => `${localizeAppMessage(label)} is temporarily unavailable: ${localizeAppMessage(evidence)}`],
  [/^(Groq|Gemini) 没有返回文字(?:（(.+)）)?$/, (_, provider, reason) => `${provider} returned no text${reason ? ` (${reason})` : ''}`],
  [/^(免费密钥|付费密钥)被拒绝（([\s\S]+)）(，改用付费密钥)?$/, (_, key, evidence, switched) => `${keyName(key)} rejected (${evidence})${switched ? '; switching to the paid API key' : ''}`],
  [/^文件扩展名是 (.+)，实际内容是 (.+) 格式，已按 (.+) 处理$/, (_, ext, actual, used) => `The file extension is ${ext}, but its contents are ${actual}; processing it as ${used}`],
  [/^此阶段使用一次性子代理，缺少：(.+)。补充要求用于后续阶段。$/, (_, missing) => `This stage uses a one-off child agent; missing: ${missing.split('、').map(item => localizeAppMessage(item)).join(', ')}. Additional requirements apply to later stages.`],
  [/^上下文校正未完成：([\s\S]+)；待校正句子会保留重试。$/, (_, error) => `Context correction did not finish: ${localizeAppMessage(error)}. Pending sentences are retained for retry.`],
  [/^(.+) 已完成的部分已保存，可在「音频转录」页点「接着做」$/, (_, stage) => `${localizeAppMessage(stage)} Completed work is saved; select Resume in Audio transcription`],
  [/^(.+) not found$/, (_, label) => `${Object.hasOwn(labels, label) ? labels[label] : label} not found`],
  [/^(.+) is required$/, (_, label) => `${Object.hasOwn(labels, label) ? labels[label] : label} is required`],
  [/^(.+)格式或长度无效$/, (_, name) => `Invalid format or length for ${localizeAppMessage(name)}`],
  [/^(.+) 必须是不超过 (\d+) 字的字符串$/, (_, name, limit) => `${name} must be a string of at most ${limit} characters`],
  [/^(.+)不能为空，且最多 (\d+) 字$/, (_, name, limit) => `${name} must be nonempty and contain at most ${limit} characters`],
  [/^(.+)需要(非空)?文本，最多 (\d+) 字$/, (_, name, required, limit) => `${name} requires ${required ? 'nonempty ' : ''}text of at most ${limit} characters`],
  [/^(.+)不存在，请刷新$/, (_, name) => `${name} not found; refresh`],
  [/^不支持的(音频|字幕)格式(?: (.*))?；支持 (.+)$/, (_, type, ext, supported) => `Unsupported ${type === '音频' ? 'audio' : 'subtitle'} format${ext ? ` ${ext === '（无扩展名）' ? '(no extension)' : ext}` : ''}; supported: ${supported.replaceAll('、', ', ')}`],
  [/^音频文件已改变：(.+)。请作为新批次重新提交$/, (_, filename) => `The audio file changed: ${filename}. Submit it as a new batch`],
  [/^重复内容：(.+)；保留顺序并复用已完成的处理，不重复请求模型$/, (_, filename) => `Duplicate content: ${filename}. Order is retained and completed processing is reused without duplicate model requests`],
  [/^校对 (\d+)\/(\d+)$/, (_, done, total) => `Proofreading ${done}/${total}`],
  [/^翻译 (\d+)\/(\d+)$/, (_, done, total) => `Translating ${done}/${total}`],
  [/^转写 (\d+)\/(\d+)$/, (_, done, total) => `Transcribing ${done}/${total}`],
  [/^复核存疑处 (\d+)\/(\d+)$/, (_, done, total) => `Reviewing uncertain passages ${done}/${total}`],
  [/^已存为 (\d+) 份资料(?:，校对修正 (\d+) 处)?$/, (_, count, corrected) => `Saved as ${count} source(s)${corrected === undefined ? '' : `; ${corrected} proofreading correction(s)`}`],
  [/^发布前逐题复审 (\d+)\/(\d+)$/, (_, done, total) => `Reviewing questions before publication ${done}/${total}`],
  [/^已发布 (\d+) 题(?:；(\d+) 题留在草稿待处理)?$/, (_, accepted, rejected) => `Published ${accepted} question(s)${rejected === undefined ? '' : `; ${rejected} remain in the draft for repair`}`],
  [/^修复第 (\d+)\/(\d+) 题(?: · 第 (\d+) 次)?$/, (_, done, total, attempt) => `Repairing question ${done}/${total}${attempt === undefined ? '' : ` · Attempt ${attempt}`}`],
  [/^独立复审 (.+)$/, (_, cardId) => `Independent review ${cardId}`],
  [/^(\d+) 题已修好并通过独立复审，等待发布$/, (_, count) => `${count} question(s) repaired and independently reviewed; awaiting publication`],
  [/^已修好 (\d+)\/(\d+) 题；其余题留在草稿，请查看待处理问题$/, (_, done, total) => `Repaired ${done}/${total} questions; the rest remain in the draft. Review the pending issues`],
  [/^复核完成：改进正稿 (\d+) 处 · 判定原文无误 (\d+) 处 · 仍拿不准 (\d+) 处$/, (_, applied, rejected, unsure) => `Review complete: ${applied} correction(s) applied · ${rejected} passage(s) confirmed · ${unsure} still uncertain`],
  [/^同时处理的录音数应是 1 到 (\d+) 的整数$/, (_, count) => `Concurrent recordings must be an integer from 1 to ${count}`],
  [/^文件没有传完（(\d+) \/ (\d+) 字节），请重新选择$/, (_, received, size) => `The upload is incomplete (${received} / ${size} bytes); choose the file again`],
  [/^路径必须是绝对路径：(.+)$/, (_, path) => `The path must be absolute: ${path}`],
  [/^找不到：(.+)$/, (_, path) => `Not found: ${path}`],
  [/^只能导入 \.json 或 \.txt 文件：(.+)$/, (_, path) => `Only .json or .txt files can be imported: ${path}`],
  [/^一次最多导入 (\d+) 个文件$/, (_, count) => `Import at most ${count} files at a time`],
  [/^JSON 格式错误：([\s\S]+)$/, (_, error) => `Invalid JSON: ${error}`],
  [/^第 (\d+) 题必须是对象$/, (_, index) => `Question ${index} must be an object`],
  [/^导入结构错误：\n([\s\S]+)$/, (_, details) => `Invalid import structure:\n${details}`],
  [/^还有 (\d+) 句正在翻译，请稍等几秒再保存$/, (_, count) => `${count} sentence(s) are still being translated. Wait a few seconds before saving`],
  [/^后台(助教|子代理)未完成：([\s\S]+)$/, (_, type, detail) => `The background ${type === '助教' ? 'tutor' : 'agent'} did not complete: ${detail}`],
  [/^模型没有按要求返回 JSON（回复开头是「([\s\S]*)」）$/, (_, evidence) => `The model did not return the requested JSON (response starts with "${evidence}")`],
  [/^第 (\d+) 段校对失败，这一段保留原转写：([\s\S]+)$/, (_, part, error) => `Proofreading segment ${part} failed; its original transcript was retained: ${localizeAppMessage(error)}`],
  [/^((?:转写|校对|翻译)第 \d+\/\d+ (?:段|部分)(?:（约 \d+ 分钟，[\d.]+ MB）)?)失败：([\s\S]+)$/, (_, label, error) => `${localizeAppMessage(label)} failed: ${localizeAppMessage(error)}`],
  [/^(转写|校对|翻译)第 (\d+)\/(\d+) (?:段|部分)(?:（约 (\d+) 分钟，([\d.]+) MB）)?$/, (_, type, part, total, minutes, mb) => `${{ 转写: 'Transcription', 校对: 'Proofreading', 翻译: 'Translation' }[type]} segment ${part}/${total}${minutes === undefined ? '' : ` (about ${minutes} minutes, ${mb} MB)`}`],
  [/^连续 (\d+) 段用同样的错误失败（([\s\S]+)）。已停下，免得白白消耗额度；转写和已完成的部分都保留着，问题解决后点「接着做」$/, (_, count, error) => `${count} consecutive segments failed with the same error (${error}). Processing stopped to avoid wasting quota. The transcript and completed work are retained; select Resume after resolving the problem`],
  [/^页码超出 PDF 范围（共 (\d+) 页），请重新选择$/, (_, count) => `Page numbers exceed the PDF's ${count} pages; select them again`],
  [/^所选 (\d+) 页均未提取到足够文字（第 (.+) 页）。若是扫描件，请先 OCR 后重新导入；本次没有保存资料。$/, (_, count, pages) => `Insufficient text was extracted from all ${count} selected pages (${pages.replaceAll('、', ', ')}). Run OCR on scanned pages and import again. No sources were saved`],
  [/^一次最多 (\d+) 道题，当前选中 (\d+) 道，请缩小范围$/, (_, max, selected) => `At most ${max} questions are allowed; ${selected} are selected. Narrow the scope`],
  [/^Deck not found \/ 题组不存在: (.+)$/, (_, id) => `Deck not found: ${id}`],
  [/^备份中的 (.+) 包含无效记录$/, (_, field) => `The backup contains invalid records in ${field}`],
  [/^备份中的 (.+) ID 缺失或重复$/, (_, field) => `The backup contains missing or duplicate ${field} IDs`],
  [/^学习库有损坏文件，其他内容可查看；请修复后再保存，避免覆盖原数据：([\s\S]+)$/, (_, paths) => `The study library contains damaged files. Other content remains readable; repair these files before saving to avoid overwriting original data: ${paths}`],
  [/^学习库保存失败：文件持续被占用或没有替换权限。请关闭占用该文件的程序，并检查文件是否只读，然后重试。原学习库未被覆盖。\n([\s\S]+)$/, (_, error) => `The study library could not be saved because its file is locked or replacement is not permitted. Close the program holding it and check whether the file is read-only, then retry. The original library was not overwritten.\n${error}`],
  [/^每一段都要翻译，缺少或为空的段落编号：(.+)$/, (_, ids) => `Every paragraph must be translated; missing or empty paragraph IDs: ${ids.replaceAll('、', ', ')}`],
  [/^英文填空原文必须原样保留全部 \{\{id\}\} 空位标记（应恰为 (.+)）$/, (_, ids) => `The English cloze text must preserve all {{id}} markers exactly (${ids})`],
  [/^每个空位的英文答案都要给出，缺少：(.+)$/, (_, ids) => `Every blank requires an English answer; missing: ${ids.replaceAll('、', ', ')}`],
  [/^每个选项的英文 text 与 explanation 都要给出（按原 id），缺少：(.+)$/, (_, ids) => `Every option requires English text and explanation using its original ID; missing: ${ids.replaceAll('、', ', ')}`],
  [/^模型整理的骨架没有通过检查（([\s\S]+)）$/, (_, error) => `The model's outline failed validation (${localizeAppMessage(error)})`],
  [/^讲解质量检查未通过：([\s\S]+)$/, (_, details) => `Explanation quality checks failed: ${localizeAppMessage(details)}`],
  [/^第 (\d+) 处修改需要 find 与 replace 文本$/, (_, index) => `Edit ${index} requires find and replace text`],
  [/^第 (\d+) 处修改在本步材料里找不到原文，请先用 workflow.session.get 读取最新材料$/, (_, index) => `Edit ${index} cannot find the original text in this step. Read the latest material with workflow.session.get first`],
  [/^第 (\d+) 处修改的原文出现了 (\d+) 次，请带上更多上下文使它唯一$/, (_, index, count) => `Edit ${index} matches ${count} passages. Add context to make the match unique`],
  [/^ffmpeg 没能处理这段音频（退出码 (.+)）：([\s\S]+)$/, (_, code, error) => `ffmpeg could not process the audio (exit code ${code}): ${localizeAppMessage(error)}`],
  [/^当前 DSH 宿主未注册模型提供方「(.+)」（NO_ADAPTER）。请在当前宿主的模型设置中启用该提供方后点「接着做」；已保存的转写会继续复用。$/, (_, provider) => `The current DSH host has not registered provider "${provider}" (NO_ADAPTER). Enable it in the host's model settings and select Resume. Saved transcripts will be reused`],
  [/^密钥被拒绝：([\s\S]+)$/, (_, error) => `The API key was rejected: ${error}`],
  [/^连接关闭（(\d+)）$/, (_, code) => `Connection closed (${code})`],
  [/^连接中断：([\s\S]+)。已记录的内容已保存，可以从列表打开。$/, (_, error) => `Connection interrupted: ${localizeAppMessage(error)}. Recorded content was saved and can be opened from the list`],
  [/^翻译停止：([\s\S]+)$/, (_, error) => `Translation stopped: ${localizeAppMessage(error)}`],
  [/^文件里能识别的 MP3 音频只占 (\d+)%，不像是有效的 MP3（可能被改过扩展名，或文件已损坏）$/, (_, percent) => `Only ${percent}% of the file contains recognizable MP3 audio. It may have a changed extension or be damaged`],
  [/^这份音频约 (\d+) 分钟，超过单次转写的 1 小时上限，而这种格式不能在本地切分；请先转成 MP3（例如 ffmpeg -i 输入 -b:a 96k 输出.mp3）$/, (_, minutes) => `This recording is about ${minutes} minutes, above the one-hour transcription limit, and its format cannot be split locally. Convert it to MP3 first, for example: ffmpeg -i input -b:a 96k output.mp3`],
];
const labels = { 笔记: 'Note', 目标题组: 'Target deck', 陪学记录: 'Coaching record', 学习流: 'Workflow', 学习记录: 'Study session',
  步骤名称: 'Step name', 流程名称: 'Workflow name', 流程说明: 'Workflow description', 学习主题: 'Study topic', 请求ID: 'Request ID', '请求 ID': 'Request ID', 学习目标: 'Study goal', 回答: 'Answer', 具体疑问: 'Specific question' };
const keyName = key => ({ 免费密钥: 'Free API key', 付费密钥: 'Paid API key', 'Groq 密钥': 'Groq API key', 硅基流动密钥: 'SiliconFlow API key', 密钥: 'API key' })[key];
const providerName = name => name === '硅基流动' ? 'SiliconFlow' : name;
const fallbackKey = key => key === '付费密钥' ? 'the paid API key' : providerName(key.trim());

/** Translate exact application messages; unknown/provider prose and interpolated user values stay intact. */
export function localizeAppMessage(text, language = 'en') {
  if (language !== 'en' || typeof text !== 'string') return text;
  if (Object.hasOwn(english, text)) return english[text];
  if (Object.hasOwn(labels, text)) return labels[text];
  for (const [pattern, format] of templates) { const match = text.match(pattern); if (match) return format(...match); }
  return text;
}

const proseFields = ['stage', 'message', 'error', 'note', 'next', 'summary'];
const localizeFields = (value, fields = proseFields) => {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const field of fields) if (typeof result[field] === 'string') result[field] = localizeAppMessage(result[field]);
  if (Array.isArray(result.warnings)) result.warnings = result.warnings.map(text => localizeAppMessage(text));
  return result;
};
const jobView = job => {
  const result = localizeFields(job);
  if (typeof result?.label === 'string') result.label = result.label.replace(/^(帮我弄懂|提升质量) · /, (_, mode) => `${localizeAppMessage(mode)} · `);
  for (const field of ['members', 'tasks', 'steps']) if (Array.isArray(result?.[field])) result[field] = result[field].map(jobView);
  if (result?.members && result.warnings) {
    const membersByFilename = new Map();
    let ambiguousPrefixes = false;
    for (const member of result.members) {
      if (member.filename.includes('：')) ambiguousPrefixes = true;
      if (!membersByFilename.has(member.filename)) membersByFilename.set(member.filename, member);
    }
    result.warnings = result.warnings.map(warning => {
      const separator = warning.indexOf('：');
      // Fullwidth colons are valid in filenames; match the longest complete filename.
      const member = ambiguousPrefixes ? result.members.reduce((longest, candidate) =>
        warning.startsWith(`${candidate.filename}：`) && (!longest || candidate.filename.length > longest.filename.length) ? candidate : longest, null)
        : separator < 0 ? null : membersByFilename.get(warning.slice(0, separator));
      return member ? `${member.filename}: ${localizeAppMessage(warning.slice(member.filename.length + 1))}` : warning;
    });
  }
  return result;
};
const inboxView = inbox => inbox && ({ ...inbox, items: inbox.items?.map(item => ({ ...item, label: localizeAppMessage(item.label),
  ...(item.kind?.startsWith('audio-') ? { detail: localizeAppMessage(item.detail), deckTitle: 'Audio transcription' } :
    item.kind === 'note' ? { detail: item.detail?.replace(/^笔记草稿「(.+)」已生成，请审阅后发布$/, (_, title) => `Note draft "${title}" was generated; review it before publishing`) } :
      item.kind === 'coach' ? { detail: item.detail?.replace(/^换个角度再讲：/, 'Another explanation: ') } : {}) })) });
const noteView = note => note?.generation ? { ...note, generation: localizeFields(note.generation) } : note;
const workflowView = session => session && ({ ...session, ...(session.skeletonJob ? { skeletonJob: localizeFields(session.skeletonJob) } : {}),
  ...(session.records ? { records: Object.fromEntries(Object.entries(session.records).map(([id, record]) => [id,
    record.teaching ? { ...record, teaching: localizeFields(record.teaching, ['message', 'error']) } : record])) } : {}) });
const liveView = session => {
  const result = jobView(session);
  if (session?.correction) result.correction = { ...session.correction, error: localizeAppMessage(session.correction.error),
    ...(session.correction.background ? { background: { ...session.correction.background, tasks: session.correction.background.tasks?.map(jobView) } } : {}) };
  return result;
};

/** Project only owned response metadata, never saved card/source/note prose or opaque identifiers. */
export function localizeAppResponse(value, action, language) {
  if (language !== 'en' || !value || typeof value !== 'object' || Array.isArray(value) || action === 'state.read') return value;
  let result = value;
  if (action === 'snapshot') {
    result = { ...value, ...(value.jobs ? { jobs: value.jobs.map(jobView) } : {}), ...(value.inbox ? { inbox: inboxView(value.inbox) } : {}) };
    if (value.assist) result.assist = value.assist.map(jobView);
    if (value.notes) result.notes = value.notes.map(noteView);
  } else if (action === 'inbox') result = inboxView(value);
  else if (action === 'jobs' || action.startsWith('job.') || /^(audio\.|live\.|draft\.(publish|repair)\.start|generate|supplement|selection\.|assist\.)/.test(action)) {
    result = jobView(value);
    if (Array.isArray(value.jobs)) result.jobs = value.jobs.map(jobView);
    if (action === 'audio.test') for (const tier of ['free', 'paid', 'groq']) if (value[tier]) result[tier] = localizeFields(value[tier]);
    if (action.startsWith('live.')) { result = liveView(value); if (value.sessions) result.sessions = value.sessions.map(liveView); }
  } else if (action.startsWith('workflow.')) {
    result = { ...value, ...(value.session ? { session: workflowView(value.session) } : {}) };
    if (value.sessions) result.sessions = value.sessions.map(workflowView);
    if (value.records || value.skeletonJob) result = workflowView(result);
  } else if (action.startsWith('note.')) {
    result = localizeFields(noteView(value), ['reason']);
    if (value.notes) result.notes = value.notes.map(noteView);
  } else if (['source.import', 'legacy.import'].includes(action) && value.warnings) {
    result = { ...value, warnings: value.warnings.map(text => localizeAppMessage(text)) };
  }
  return result;
}

export function localizedAppError(error, language) {
  if (language !== 'en') return error;
  const message = localizeAppMessage(error?.message, language);
  if (message === error?.message) return error;
  return Object.assign(new Error(message, { cause: error }), error, { message, name: error.name });
}
