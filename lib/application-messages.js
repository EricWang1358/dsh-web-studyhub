import bundledEnglish from './application-messages-en.js';
import { isJobKind } from './inbox-kinds.js';

// The server and Node keep the table they import. The DSH client's host build gives this module an empty table instead (scripts/build.mjs
// englishOnDemand) and ui/i18n.js hands it the real one with the rest of the English catalogue, when the interface is English.
let english = bundledEnglish;
/** The client's English catalogue arrived (ui/i18n.js loadEnglishCatalogue). Nothing on the server calls this. */
export function installEnglishAppMessages(table) { if (table && typeof table === 'object') english = table; }

const templates = [
  // The lost-audio note follows whatever else the live class says (lib/live.js snapshot joins them with ；). Before every other template, so none of their open-ended details swallows it.
  [/^([\s\S]+)；(转写连接断开期间，约 \d+ 秒的声音没有转写)$/, (_, said, note) => joinParts([localizeAppMessage(said), localizeAppMessage(note)])],
  // The one-click MinerU install: a file of its settings folder MinerU cannot read (lib/mineru-install-text.js homePermissions, #936).
  [/^MinerU 读不了配置文件夹里的 (.+)（权限不对）。安装位置没问题，不用换位置。$/, (_, file) => `MinerU cannot read ${file} in its settings folder (wrong permissions). The install location is fine; there is no need to move it.`],
  [/^一次范围练习最多选 (\d+) 道题（这次传了 (\d+) 道）$/, (_, limit, count) => `A scoped practice round accepts at most ${limit} questions (got ${count})`],
  // The whole-period study plan of a course (备考计划, lib/courses.js checkedPlan): the limits that carry a number.
  [/^(休息日期 restDates|模拟考日期 mockDates)需为 YYYY-MM-DD 日期列表，最多 (\d+) 个$/, (_, name, limit) => `${name.split(' ')[1]} must be a list of YYYY-MM-DD dates, at most ${limit}`],
  [/^备考计划阶段最多 (\d+) 个$/, (_, limit) => `A study plan can have at most ${limit} phases`],
  [/^(缺失材料|调整规则|备注) (missing|rules|notes)过长$/, (_, _name, key) => `${key} is too long (at most 2000 characters)`],
  // A course's study method (学法, lib/course-method.js checkedMethod): per-stage validation messages.
  [/^第 (\d+) 个阶段需为对象$/, (_, at) => `Stage ${at} must be an object`],
  [/^第 (\d+) 个阶段的名称需为 1–(\d+) 个字$/, (_, at, limit) => `Stage ${at}'s name must be 1–${limit} characters`],
  [/^第 (\d+) 个阶段的主活动需为 (.+) 之一$/, (_, at, list) => `Stage ${at}'s main activity must be one of ${list}`],
  [/^第 (\d+) 个阶段最多 (\d+) 个「也可以」$/, (_, at, limit) => `Stage ${at} can have at most ${limit} “You can also” options`],
  [/^第 (\d+) 个阶段的「也可以」需为 (.+) 之一$/, (_, at, list) => `Stage ${at}'s “You can also” options must be chosen from ${list}`],
  [/^第 (\d+) 个阶段的「也可以」有重复$/, (_, at) => `Stage ${at} has duplicate “You can also” options`],
  [/^第 (\d+) 个阶段的「也可以」不能与主活动相同$/, (_, at) => `Stage ${at}'s “You can also” options cannot match its main activity`],
  [/^第 (\d+) 个阶段的过关宽严需为 (.+) 之一$/, (_, at, list) => `Stage ${at}'s gate strictness must be one of ${list}`],
  // Marker (lib/marker-local.js MARKER_TEXT): why a run failed, and a marker-pdf 2.x that needs Docker.
  [/^Marker 退出码 (-?\d+)：([\s\S]+)$/, (_, code, cause) => `Marker exited with code ${code}: ${cause}`],
  [/^Marker 退出码 (-?\d+)，没有输出原因。$/, (_, code) => `Marker exited with code ${code} and printed no reason.`],
  [/^已安装的 Marker 是 (\d+)\.x，它要用 Docker 跑推理服务，但这台电脑上没有找到 Docker。可以安装并启动 Docker Desktop；不想用 Docker 的话，点「修复安装（改装 1\.x）」。$/,
    (_, major) => `The installed Marker is ${major}.x, which runs its inference server in Docker, but Docker was not found on this computer. You can install and start Docker Desktop; if you would rather not use Docker, choose “Repair: install 1.x”.`],
  [/^已安装的 Marker 是 (\d+)\.x，它要用 Docker 跑推理服务，但 Docker 没有运行。请启动 Docker Desktop，等它显示正在运行后点「重新检测」；不想用 Docker 的话，点「修复安装（改装 1\.x）」。$/,
    (_, major) => `The installed Marker is ${major}.x, which runs its inference server in Docker, but Docker is not running. Start Docker Desktop, wait until it says it is running, then choose “Check again”; if you would rather not use Docker, choose “Repair: install 1.x”.`],
  [/^已安装的 Marker 是 (\d+)\.x，它要用 Docker 跑推理服务。请启动 Docker Desktop；不想用 Docker 的话，点「修复安装（改装 1\.x）」。$/,
    (_, major) => `The installed Marker is ${major}.x, which runs its inference server in Docker. Start Docker Desktop; if you would rather not use Docker, choose “Repair: install 1.x”.`],
  [/^连续 (\d+) 页没能写入索引，已停止：([\s\S]+)$/, (_, count, detail) => `${count} pages in a row could not be written to the index; stopped: ${detail}`],
  [/^GitHub 下载(校验清单|检索扩展)失败（HTTP (\d+)）。这个版本可能还没有发布检索扩展，稍后再试。$/, (_, what, status) => `GitHub download of the ${what === '校验清单' ? 'checksum list' : 'search extension'} failed (HTTP ${status}). This version may not have published the search extension yet; try again later.`],
  [/^无法从 GitHub 下载(校验清单|检索扩展)（网络不可用）。检查网络后再试。$/, (_, what) => `Cannot download the ${what === '校验清单' ? 'checksum list' : 'search extension'} from GitHub (network unavailable). Check the network and try again.`],
  [/^下载的(校验清单|检索扩展)文件过大，已停止。$/, (_, what) => `The downloaded ${what === '校验清单' ? 'checksum list' : 'search extension'} file is too large; stopped.`],
  [/^DSH 的插件目录正被另一个操作占用：可能有别的插件正在安装或更新，或者上次安装中途被打断。等一两分钟再点「安装检索扩展」；还是不行的话，完全退出 DSH 再打开，然后重试。$/, () => 'DSH’s plugin folder is busy with another operation: another plugin may be installing or updating, or an earlier install was interrupted. Wait a minute or two and click “Install the search extension” again; if it still fails, quit DSH completely, reopen it and retry.'],
  [/^DSH 没能安装检索扩展（([\s\S]+)）。$/,(_, reason) => `DSH could not install the search extension (${reason}).`],
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
  [/^读不懂这份 M4A 文件的结构（([\s\S]+)），可能不完整或已损坏$/, (_, detail) => `This M4A file's structure cannot be read (${localizeAppMessage(detail)}); it may be incomplete or damaged`],
  [/^这份 M4A 约 (\d+) 分钟，超过单次转写的 (\d+) 分钟上限，但它的内部结构不能在本地无损切分（([\s\S]+)）。请在录音软件里另存为 MP3 后再导入$/, (_, minutes, limit, reason) => `This M4A is about ${minutes} minutes, above the ${limit}-minute limit of one transcription request, and its structure cannot be split losslessly here (${localizeAppMessage(reason)}). Save it as MP3 in your recording app and import it again`],
  // Recordings longer than one request (#408): what cannot be cut here, and why.
  [/^压缩编码的 WAV 超过 (\d+) 分钟无法切分，请先转成 MP3$/, (_, limit) => `Compressed WAV recordings longer than ${limit} minutes cannot be split; convert to MP3 first`],
  [/^这份 (.+?) 约 (\d+) 分钟，超过单次转写的 (\d+) 分钟上限；这种格式要切开需要 ffmpeg，这台电脑上没有找到。请先另存为 MP3 再导入（MP3 会在本地无损切开），或安装 ffmpeg 后重试$/,
    (_, kind, minutes, limit) => `This ${kind} recording is about ${minutes} minutes, above the ${limit}-minute limit of one transcription request. Cutting this format needs ffmpeg, which is not installed on this computer. Save it as MP3 and import it again (MP3 is split losslessly here), or install ffmpeg and retry`],
  [/^这份 (.+?) 读不出时长(?:（([\s\S]+)）)?，按大小（([\d.]+) MB）估计超过单次转写的 (\d+) 分钟上限；这种格式要切开需要 ffmpeg，这台电脑上没有找到。请先另存为 MP3 再导入（MP3 会在本地无损切开），或安装 ffmpeg 后重试$/,
    (_, kind, reason, size, limit) => `The length of this ${kind} recording cannot be read${reason ? ` (${localizeAppMessage(reason)})` : ''}; at ${size} MB it is likely above the ${limit}-minute limit of one transcription request. Cutting it needs ffmpeg, which is not installed on this computer. Save it as MP3 and import it again (MP3 is split losslessly here), or install ffmpeg and retry`],
  [/^读不懂这份 OGG 文件的结构（([\s\S]+)），可能不完整或已损坏$/, (_, detail) => `This OGG file's structure cannot be read (${oggDetail(detail)}); it may be incomplete or damaged`],
  [/^「(.+)」未通过预检，其余文件尚未开始；可以跳过它继续$/, (_, filename) => `"${filename}" did not pass the pre-flight check; the other files have not started. You can skip it and continue`],
  [/^第 (\d+) 部分的小标题没有生成，已用文件名代替$/, (_, part) => `No heading was generated for part ${part}; the file name is used instead`],
  [/^连不上 Google 服务：([\s\S]+)。请检查网络；需要代理时，用 NODE_USE_ENV_PROXY=1 和 HTTPS_PROXY 启动 DSH$/, (_, evidence) => `Unable to connect to Google: ${evidence === '网络错误' ? 'Network error' : evidence}. Check the network. If a proxy is needed, start DSH with NODE_USE_ENV_PROXY=1 and HTTPS_PROXY`],
  [/^Google 超过 (\d+) 分钟没有回应（等待时间已按这一段的长度和大小放宽，并自动重试过一次）。可以在「设置 › 音频转写 › 高级(?: › 专家选项)?」里把「每次请求最长」调小后重试；已经转写好的段落有缓存，不会重复转写$/, (_, minutes) => `Google did not respond within ${minutes} minute(s), despite a length-adjusted deadline and one automatic retry. Reduce Longest per request in Settings › Audio transcription › Advanced › Expert options and retry. Completed segments are cached and will not be transcribed again`],
  [/^模型不存在或此密钥不可用：([\s\S]*)$/, (_, evidence) => `The model does not exist or is unavailable to this key: ${evidence}`],
  [/^(Groq|Gemini|硅基流动) 请求失败（([^)）]+)）：([\s\S]+?)(?:（涉及字段 ([\s\S]+)）)?$/, (_, provider, status, evidence, fields) => `${providerName(provider)} request failed (${status}): ${evidence === '没有返回原因' ? 'No reason returned' : evidence}${fields ? ` (affected fields: ${fields})` : ''}`],
  [/^(.+) 暂时不可用：([\s\S]+)$/, (_, label, evidence) => `${localizeAppMessage(label)} is temporarily unavailable: ${localizeAppMessage(evidence)}`],
  [/^(Groq|Gemini) 没有返回文字(?:（(.+)）)?$/, (_, provider, reason) => `${provider} returned no text${reason ? ` (${reason})` : ''}`],
  [/^(免费密钥|付费密钥)被拒绝（([\s\S]+)）(，改用付费密钥)?$/, (_, key, evidence, switched) => `${keyName(key)} rejected (${evidence})${switched ? '; switching to the paid API key' : ''}`],
  [/^文件扩展名是 (.+)，实际内容是 (.+) 格式，已按 (.+) 处理$/, (_, ext, actual, used) => `The file extension is ${ext}, but its contents are ${actual}; processing it as ${used}`],
  [/^此阶段使用一次性子代理，缺少：(.+)。补充要求用于后续阶段。$/, (_, missing) => `This stage uses a one-off child agent; missing: ${missing.split('、').map(item => localizeAppMessage(item)).join(', ')}. Additional requirements apply to later stages.`],
  [/^上下文校正未完成：([\s\S]+)；待校正句子会保留重试。$/, (_, error) => `Context correction did not finish: ${localizeAppMessage(error)}. Pending sentences are retained for retry.`],
  [/^(.+) 已完成的部分已保存，可在「音频转(?:写|录)」页点「接着做」$/, (_, stage) => `${localizeAppMessage(stage)} Completed work is saved; select Continue (nothing is paid for twice) in Audio transcription`],
  [/^(.+) not found$/, (_, label) => `${Object.hasOwn(labels, label) ? labels[label] : label} not found`],
  [/^(.+) is required$/, (_, label) => `${Object.hasOwn(labels, label) ? labels[label] : label} is required`],
  [/^(.+)格式或长度无效$/, (_, name) => `Invalid format or length for ${localizeAppMessage(name)}`],
  [/^(.+) 必须是不超过 (\d+) 字的字符串$/, (_, name, limit) => `${name} must be a string of at most ${limit} characters`],
  [/^(.+)不能为空，且最多 (\d+) 字$/, (_, name, limit) => `${name} must be nonempty and contain at most ${limit} characters`],
  [/^(.+)需要(非空)?文本，最多 (\d+) 字$/, (_, name, required, limit) => `${name} requires ${required ? 'nonempty ' : ''}text of at most ${limit} characters`],
  [/^(.+)不存在，请刷新$/, (_, name) => `${name} not found; refresh`],
  [/^不支持的(音频|字幕)格式(?: (.*))?；支持 (.+)$/, (_, type, ext, supported) => `Unsupported ${type === '音频' ? 'audio' : 'subtitle'} format${ext ? ` ${ext === '（无扩展名）' ? '(no extension)' : ext}` : ''}; supported: ${supported.replaceAll('、', ', ')}`],
  [/^有 (\d+) 句没有润色，保留了识别原文$/, (_, count) => `${count} sentence(s) were not polished; the recognised text is kept`],
  [/^有 (\d+) 句没有译文，文字稿里标着「这句没有译文」$/, (_, count) => `${count} sentence(s) have no translation; the transcript marks them “no translation”`],
  [/^(补完润色|补全译文)没有完成：([\s\S]+)$/, (_, what, reason) => `${what === '补完润色' ? 'Finishing the polish' : 'Finishing the translations'} did not complete: ${localizeAppMessage(reason)}`],
  [/^音频文件已改变：(.+)。请作为新批次重新提交$/, (_, filename) => `The audio file changed: ${filename}. Submit it as a new batch`],
  [/^重复内容：(.+)；保留顺序并复用已完成的处理，不重复请求模型$/, (_, filename) => `Duplicate content: ${filename}. Order is retained and completed processing is reused without duplicate model requests`],
  [/^校对 (\d+)\/(\d+)$/, (_, done, total) => `Proofreading ${done}/${total}`],
  [/^翻译 (\d+)\/(\d+)$/, (_, done, total) => `Translating ${done}/${total}`],
  [/^转写 (\d+)\/(\d+)$/, (_, done, total) => `Transcribing ${done}/${total}`],
  [/^复核存疑处 (\d+)\/(\d+)$/, (_, done, total) => `Reviewing uncertain passages ${done}/${total}`],
  [/^已存为 (\d+) 份资料(?:，校对修正 (\d+) 处)?$/, (_, count, corrected) => `Saved as ${count} source(s)${corrected === undefined ? '' : `; ${corrected} proofreading correction(s)`}`],
  [/^发布前逐[题卡]复审 (\d+)\/(\d+)$/, (_, done, total) => `Reviewing questions before publication ${done}/${total}`],
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
  [/^连续 (\d+) 段用同样的错误失败（([\s\S]+)）。已停下，免得白白消耗额度；转写和已完成的部分都保留着，问题解决后点「接着做」$/, (_, count, error) => `${count} consecutive segments failed with the same error (${error}). Processing stopped to avoid wasting quota. The transcript and completed work are retained; select Continue (nothing is paid for twice) after resolving the problem`],
  [/^页码超出 PDF 范围（共 (\d+) 页），请重新选择$/, (_, count) => `Page numbers exceed the PDF's ${count} pages; select them again`],
  [/^静态验收完成：([\d.]+)\/([\d.]+) 分$/, (_, total, max) => `Static check complete: ${total}/${max} marks`],
  [/^批改完成：([\d.]+)\/([\d.]+) 分$/, (_, total, max) => `Grading complete: ${total}/${max} marks`],
  [/^\[静态检查文件\] (.+)$/, (_, files) => `[Static check files] ${files}`],
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
  [/^当前 DSH 宿主未注册模型提供方「(.+)」（NO_ADAPTER）。请在当前宿主的模型设置中启用该提供方后点「接着做」；已保存的转写会继续复用。$/, (_, provider) => `The current DSH host has not registered provider "${provider}" (NO_ADAPTER). Enable it in the host's model settings and select Continue (nothing is paid for twice). Saved transcripts will be reused`],
  [/^密钥被拒绝：([\s\S]+)$/, (_, error) => `The API key was rejected: ${error}`],
  [/^连接关闭（(\d+)）$/, (_, code) => `Connection closed (${code})`],
  [/^连接中断：([\s\S]+)。已记录的内容已保存，可以从列表打开。$/, (_, error) => `Connection interrupted: ${localizeAppMessage(error)}. Recorded content was saved and can be opened from the list`],
  [/^翻译停止：([\s\S]+)$/, (_, error) => `Translation stopped: ${localizeAppMessage(error)}`],
  [/^文件里能识别的 MP3 音频只占 (\d+)%，不像是有效的 MP3（可能被改过扩展名，或文件已损坏）$/, (_, percent) => `Only ${percent}% of the file contains recognizable MP3 audio. It may have a changed extension or be damaged`],
  [/^这份音频约 (\d+) 分钟，超过单次转写的 1 小时上限，而这种格式不能在本地切分；请先转成 MP3（例如 ffmpeg -i 输入 -b:a 96k 输出.mp3）$/, (_, minutes) => `This recording is about ${minutes} minutes, above the one-hour transcription limit, and its format cannot be split locally. Convert it to MP3 first, for example: ffmpeg -i input -b:a 96k output.mp3`],
  // PDF conversion: the stage of a piece (upload, parse and download are the stages of cloud jobs made before 3.5.5).
  [/^(?:第 (\d+)\/(\d+) 段 · )?正在(上传|解析|下载结果|本地解析)$/, (_, index, count, step) => {
    const verb = { 上传: 'uploading', 解析: 'converting', 下载结果: 'downloading the result', 本地解析: 'converting locally' }[step];
    return index ? `Piece ${index}/${count} · ${verb}` : `${verb[0].toUpperCase()}${verb.slice(1)}`;
  }],
  // The search-index build's title and progress line.
  [/^检索批次整理没有完成，本批次会在重试时重新确认：([\s\S]+)$/, (_, error) => `Search-index batch maintenance did not finish. This batch will be confirmed again on retry: ${error}`],
  [/^建立检索索引 · ([\s\S]+)$/, (_, course) => `Build search index · ${course}`],
  [/^检索索引 · ([\s\S]+)$/, (_, course) => `Search index · ${course}`],
  [/^正在建立索引 (\d+) \/ (\d+) 页$/, (_, done, total) => `Indexing ${done} / ${total} pages`],
  // Material folder classification & course attribution background jobs (lib/contexts/materials/classify-jobs.js).
  [/^内容分类第 (\d+)\/(\d+) 批$/, (_, part, total) => `Topic classification batch ${part}/${total}`],
  [/^课程归属第 (\d+)\/(\d+) 批$/, (_, part, total) => `Course attribution batch ${part}/${total}`],
  [/^正在按内容整理分类 (\d+)\/(\d+)$/, (_, done, total) => `Classifying materials by topic ${done}/${total}`],
  [/^正在整理课程归属 (\d+)\/(\d+)$/, (_, done, total) => `Organizing course assignments ${done}/${total}`],
  // The one-click local MinerU install: its step line, the free-space refusal, a wrong version, a service that did not start.
  [/^第 (\d+)\/(\d+) 步：(.+)$/, (_, step, of, name) => `Step ${step}/${of}: ${localizeAppMessage(name)}`],
  // The local live engine (lib/live-local.js, lib/live-local-worker.mjs): why it stopped; the engine's own words stay as they are.
  [/^本地识别引擎中断（(\d+)）$/, (_, code) => `The local speech engine stopped (${code})`],
  [/^本地识别引擎已退出（代码 (-?\d+)）$/, (_, code) => `The local speech engine exited (code ${code})`],
  [/^本地识别引擎(没能启动|出错)：([\s\S]+)$/, (_, kind, detail) => `The local speech engine ${kind === '出错' ? 'failed' : 'could not start'}: ${detail}`],
  [/^本地识别引擎不可用（没能加载 sherpa-onnx）：([\s\S]+)$/, (_, detail) => `The local speech engine is unavailable (sherpa-onnx could not be loaded): ${detail}`],
  [/^本地识别模型没能加载：([\s\S]+)$/, (_, detail) => `The local speech model could not be loaded: ${detail}`],
  [/^电脑声音采音组件意外退出（代码 (.+)）$/, (_, code) => `The system-audio capture component exited unexpectedly (code ${code})`],
  [/^转写连接断开期间，约 (\d+) 秒的声音没有转写$/, (_, seconds) => `About ${seconds} second${seconds === '1' ? '' : 's'} of audio ${seconds === '1' ? 'was' : 'were'} not transcribed while the transcription connection was down`],
  [/^本地识别收尾超时，约 ([\d.]+) 秒音频仍在排队，尾段也可能尚未定稿。已完成的文字已保留。$/, (_, seconds) => `Local transcription stopped making progress while finishing. About ${seconds} seconds of audio remain queued, and the trailing segment may still be unfinished. Completed text has been kept.`],
  [/^(.+) 剩余 (.+)，至少需要 (.+)。请换一个空间更大的磁盘。$/, (_, drive, free, need) => `${drive} has ${free} free; at least ${need} is needed. Choose a disk with more room.`],
  [/^装好的 MinerU 版本是 (.+)，StudyHub 需要 4\.x。$/, (_, version) => `The installed MinerU is version ${version === '未知' ? 'unknown' : version}; StudyHub needs 4.x.`],
  [/^本机服务没能启动：([\s\S]+)$/, (_, detail) => `The local service could not start: ${detail === '没有返回原因' ? 'No reason returned' : detail}`],
  [/^本机 MinerU 服务没能启动。点「接着做」再试一次；还是不行就到「设置 › PDF 转换」点「重新启动服务」。（([\s\S]+)）$/, (_, detail) => `The local MinerU service could not start. Choose Resume to try again; if it still fails, choose “Restart the service” under Settings › PDF conversion. (${localizeAppMessage(detail)})`],
  [/^已存为 (\d+) 页资料$/, (_, count) => `Saved as ${count} page${count === '1' ? '' : 's'} of material`],
  [/^这份 PDF 已有一份转换好、等你导入的文字（你改过 (\d+) 处）。重新转换不会覆盖它：请先在「任务」(的「已归档」里取消归档，再|里)导入它，或放弃它再转换。$/, (_, edited, where) => `This PDF already has converted text waiting for you to import (you changed ${edited} place${edited === '1' ? '' : 's'}). Converting it again will not overwrite that: first ${where === '里' ? '' : 'unarchive it under Archived in Tasks, then '}import it, or discard it${where === '里' ? ' in Tasks' : ''}, and then convert again.`],
  [/^缺少第 ([\d–]+) 页的解析结果，没法合并成整本书。请重试没完成的分段。$/, (_, pages) => `No result for pages ${pages}, so the book cannot be merged. Retry the pieces that did not finish.`],
  [/^PDF 的分段重叠了（第 ([\d–]+) 页），没法合并。$/, (_, pages) => `The PDF's pieces overlap (pages ${pages}) and cannot be merged.`],
  [/^分段超出了这个 PDF 的页数（共 (\d+) 页）。$/, (_, pages) => `The pieces go beyond this PDF's page count (${pages} pages).`],
  [/^第 ([\d–]+) 页这一段的解析结果里出现了超出这一段页数的页码，没法合并。请重试这一段。$/, (_, pages) => `The result for pages ${pages} contains a page number outside this piece, so it cannot be merged. Retry this piece.`],
  [/^解析结果合起来有 (\d+) MB，超过了 (\d+) MB 的导入上限。请把这本书分成两份 PDF 再导入。$/, (_, size, limit) => `The merged result is ${size} MB, over the import limit of ${limit} MB. Split the book into two PDFs and import them separately.`],
  [/^这个 PDF 的第 (\d+) 页单独就有 (\d+) MB，超过云端解析单个文件的上限，没法拆小。请先压缩这一页的图片，或(?:用桌面客户端处理|改用本机解析)。$/, (_, page, size) => `Page ${page} of this PDF is ${size} MB on its own, over the per-file limit of cloud conversion, and cannot be split further. Compress the images on this page first, or switch to local conversion.`],
  [/^MinerU 返回了意料之外的结果（([\s\S]+)）。请稍后再试。$/, (_, detail) => `MinerU returned an unexpected result (${detail}). Try again later.`],
  [/^本地解析返回了 (\d+) 页，这一段（第 ([\d–]+) 页）应有 (\d+) 页。请重试这一段。$/, (_, found, pages, expected) => `Local conversion returned ${found} pages; this piece (pages ${pages}) should have ${expected}. Retry this piece.`],
  [/^本地解析返回的页码（第 (\d+) 页）不在这一段（第 ([\d–]+) 页）里，没法放到正确的页上。请重试这一段。$/, (_, page, pages) => `Local conversion returned page ${page}, which is outside this piece (pages ${pages}), so it cannot be placed on the right page. Retry this piece.`],
  [/^本地解析返回的页码有重复（这一段是第 ([\d–]+) 页）。请重试这一段。$/, (_, pages) => `Local conversion returned a repeated page number (this piece is pages ${pages}). Retry this piece.`],
  [/^本地解析读到的总页数（(\d+)）和这个 PDF 的页数（(\d+)）不一致，没法确认页码对得上。请重试这一段。$/, (_, reported, actual) => `Local conversion read a total of ${reported} pages but this PDF has ${actual}, so the page numbers cannot be confirmed. Retry this piece.`],
  [/^本地服务没能启动：([\s\S]+)$/, (_, detail) => `The local service could not start: ${detail === '没有返回原因' ? 'No reason returned' : detail}`],
  [/^本地解析没有成功：([\s\S]+)$/, (_, detail) => `Local conversion did not succeed: ${detail === '没有返回原因' ? 'No reason returned' : detail}`],
  [/^PDF 已加入 (MinerU|Marker) (本机|云端) 解析队列（(?:正在解析「(.+)」|前面还有 (\d+) 份 PDF 正在解析)，完成后自动开始），进度在资料页，(完成后自动保存为可按页引用的资料|转换好后先等学习者修改，确认后才保存为资料)。不要重复提交。$/,
    (_, tool, where, aheadTitle, count, tail) => {
      const wait = aheadTitle ? `waiting for “${aheadTitle}” to finish` : `${count} PDF(s) ahead in line`;
      const end = tail.includes('修改') ? 'once converted it waits for the learner to edit it and is saved only when they confirm' : 'when it is done it is saved as material you can cite by page';
      const target = where === '云端' ? `${tool} cloud` : `${tool} on this computer`;
      return `The PDF was queued for ${target} (${wait}; it starts automatically afterwards). Progress is on the Sources page; ${end}. Do not submit it again.`;
    }],
  [/^不能并行：「(.+)」正在处理同一份草稿、题组或资料，两个任务同时写会互相覆盖；等它结束，或先停止它。$/, (_, title) => `Cannot run in parallel: “${title}” is working on the same draft, deck or material, and two tasks writing it at once would overwrite each other. Wait for it to finish, or stop it first.`],
  [/^模型报错，已退回排队：等前面的任务完成后自动继续（原因：(.+)）$/, (_, cause) => `The model returned an error, so this task went back to the queue and continues by itself when the tasks ahead finish (cause: ${{ '模型请求太频繁，被限流了': 'rate limit', 模型服务繁忙: 'the model service is busy', 模型长时间没有响应: 'the model took too long to respond' }[cause] || cause}).`],
  [/^(.+) 已完成的部分已保存，可在资料页点「接着做」$/, (_, stage) => `${localizeAppMessage(stage)} Completed work is saved; select Resume (finished pieces are not redone) on the Sources page`],
  [/^网页 Gemini 等待回答超时（(\d+) 秒内未完成响应）$/, (_, seconds) => `Web Gemini timed out waiting for a reply (no response within ${seconds} seconds)`],
  [/^未在 DSH 中找到指定的 MCP 工具「(.+)」。请确认服务器已启动。$/, (_, name) => `The selected MCP tool "${name}" was not found in DSH. Make sure the server is running.`],
  [/^未在 DSH 中检测到工具「(.+)」，请先确认 ask-gemini-mcp 已启用$/, (_, name) => `Tool "${name}" was not detected in DSH; make sure ask-gemini-mcp is enabled.`],
  // M4A structure details (lib/audio-m4a.js).
  [/^(.+) 的长度不完整$/, (_, type) => `incomplete length in ${type}`],
  [/^(.+) 超出了文件或上一层$/, (_, type) => `${type} runs past the file or parent box`],
  [/^缺少 (.+)$/, (_, what) => `missing ${what}`],
  // Coach tasks, variant preparation and daily settings (lib/coach-daily.js, lib/contexts/coach/).
  [/^准备 (\d+) 道定制题$/, (_, n) => `Prepare ${n} custom question${n === '1' ? '' : 's'}`],
  [/^备好 (\d+) 道定制题$/, (_, n) => `Prepared ${n} custom question${n === '1' ? '' : 's'}`],
  [/^按「(.+)」改题$/, (_, tags) => `Revise question (${tags.split('、').map(coachTag).join(', ')})`],
  [/^陪学按反馈修改：(.+)$/, (_, tags) => `Revised by coach from feedback: ${tags.split('、').map(coachTag).join(', ')}`],
  [/^已备好的变式题已经攒满（(\d+) 道），先去练掉一些再生成$/, (_, max) => `Prepared variants are full (${max} ready); practise some before generating more`],
  [/^每条学习偏好不超过 (\d+) 字$/, (_, max) => `Each learning preference can be at most ${max} characters`],
  [/^学习偏好最多保存 (\d+) 条$/, (_, max) => `At most ${max} learning preferences can be saved`],
  [/^(.+)：这个任务没有这个设置（可调：(.+)）$/, (_, key, list) => `${key}: this task has no such setting (adjustable: ${list.replaceAll('、', ', ')})`],
  [/^(.+) 要是 (\d+) 到 (\d+) 的整数$/, (_, key, min, max) => `${key} must be a whole number from ${min} to ${max}`],
  [/^(.+) 只能是 (.+) 之一$/, (_, key, list) => `${key} must be one of ${list.replaceAll('、', ', ')}`],
  // Case study, grading, voice, jobs, study method, course & custom plan limits.
  [/^总分请设在 (\d+)–(\d+) 之间$/, (_, min, max) => `Set total marks between ${min} and ${max}`],
  [/^粘贴的真题过长（当前上限 (\d+) 字；请精简片段或调高样题字数上限）$/, (_, limit) => `The pasted past paper is too long (current limit: ${limit} characters; shorten the excerpt or raise the sample limit)`],
  [/^(每道题的)?答案请控制在 (\d+) 字以内$/, (_, each, limit) => `Keep ${each ? 'each answer' : 'your answer'} within ${limit} characters`],
  [/^语音回答最长 (\d+) 秒，请分段说$/, (_, s) => `A voice answer is at most ${s} seconds. Say it in parts`],
  [/^参考样题资料已不存在或已归档（(.+)），无法按原样题规格复审待审题目。请恢复样题资料，或显式确认降级复审后发布（allowMissingReferences: true）。$/, (_, ids) => `Reference sample materials are missing or archived (${ids}), so pending questions cannot be reviewed against the original sample spec. Restore them, or pass allowMissingReferences: true to confirm degraded review.`],
  [/^所选参考样题资料有 (\d+) 份已被删除或(已归档（含已归档：(.+)）|内容为空)，无法按原样题(出题|修题)。请先到「资料」页恢复或重新导入样题；确要不参考样题继续，需在主会话里让助手加上 allowMissingReferences: true。$/, (_, n, why, titles, task) => `${n} of the selected reference sample materials ${titles ? `are deleted or archived (archived: ${titles})` : 'are deleted or empty'}, so questions cannot ${task === '修题' ? 'be repaired' : 'be made'} against the original samples. Restore or re-import the samples in Materials; to go on without them, ask the assistant in the main chat to add allowMissingReferences: true.`],
  [/^一次最多处理 (\d+) 个任务，请分几次来$/, (_, max) => `At most ${max} jobs at a time; please do it in several steps`],
  [/^第 (\S+) 章现在是「(.+)」，不是「(.+)」：书的章节变了，请重新选这一章 \(the chapter is another one now\)$/, (_, ch, nowTitle, oldTitle) => `Chapter ${ch} is now “${nowTitle}”, not “${oldTitle}”: the book's chapters changed; select this chapter again`],
  [/^Leaf (.+): 考情 records the fingerprint of its paper places$/, (_, id) => `Leaf ${id}: exam-history metadata records the fingerprint of its paper places`],
  [/^Exam point (.+): at most two levels \(a 大考点 has no parent\)$/, (_, id) => `Exam point ${id}: at most two levels (a top-level exam point has no parent)`],
  [/^第 (\d+) 个阶段的范围（scope）需为对象$/, (_, at) => `Stage ${at}'s scope must be an object`],
  [/^第 (\d+) 个阶段的范围只支持 (.+)$/, (_, at, keys) => `Stage ${at}'s scope only supports ${keys}`],
  [/^第 (\d+) 个阶段的 (.+) 需为不超过 (\d+) 项的非空文本列表（每项不超过 (\d+) 字）$/, (_, at, key, max, itemMax) => `Stage ${at}'s ${key} must be a list of at most ${max} nonempty strings (up to ${itemMax} characters each)`],
  [/^(.+)需为 0–(\d+) 的阶段序号列表$/, (_, label, max) => `${localizeAppMessage(label)} must be a list of stage indices from 0 to ${max}`],
  [/^(目标|当前)阶段序号需为 0–(\d+) 的整数(，或不填)?$/, (_, which, max, opt) => `${which === '目标' ? 'Target' : 'Current'} stage index must be an integer from 0 to ${max}${opt ? ', or omitted' : ''}`],
  [/^学法名称需为 1–(\d+) 个字$/, (_, max) => `The study method name must be 1–${max} characters`],
  [/^学法需有 1–(\d+) 个阶段$/, (_, max) => `A study method must have 1–${max} stages`],
  [/^出题守则最多 (\d+) 条，每条不超过 (\d+) 字$/, (_, c, l) => `At most ${c} generation rules, up to ${l} characters each`],
  [/^每周章数需为 (\d+)–(\d+) 的整数$/, (_, min, max) => `Chapters per week must be a whole number from ${min} to ${max}`],
  [/^每日学习分钟数需为 (\d+)–(\d+)$/, (_, min, max) => `Minutes per day must be between ${min} and ${max}`],
  [/^(.+)需为 YYYY-MM-DD 日期列表，最多 (\d+) 个$/, (_, label, limit) => `${localizeAppMessage(label)} must be a list of YYYY-MM-DD dates, at most ${limit}`],
  [/^指定章节需选 1 到 (\d+) 章，每个章节编号是不超过 (\d+) 字的文字$/, (_, c, l) => `Choose 1 to ${c} chapters; each chapter id is text of at most ${l} characters`],
  [/^章节标题需与章节编号一一对应，每个不超过 (\d+) 字$/, (_, l) => `Chapter titles must match chapter IDs one-to-one, up to ${l} characters each`],
  [/^范围备注不超过 (\d+) 字$/, (_, l) => `The scope note is at most ${l} characters`],
  [/^复习全书的部分只能是 (.+)$/, (_, list) => `The review book parts can only be ${list.replaceAll('、', ', ')}`],
  [/^题型只能是 (.+)$/, (_, list) => `The question kinds can only be ${list.replaceAll('、', ', ')}`],
  [/^请选择不超过 (.+) 的 PDF 文件$/, (_, mb) => `Choose a PDF file of at most ${mb}`],
  [/^PDF 文件无效或超过 (.+)$/, (_, mb) => `The PDF is invalid or exceeds ${mb}`],
  [/^文件不是有效 PDF，或超过 (.+)$/, (_, mb) => `The file is not a valid PDF or exceeds ${mb}`],
  [/^PDF 超过 (\d+) 页，请先按章节拆分$/, (_, p) => `The PDF exceeds ${p} pages. Split it into chapters first`],
  [/^所选 PDF 页面(?:的文字)?超过 ([\d,]+) 字符，请减少页数$/, (_, c) => `Text from the selected PDF pages exceeds ${c} characters; select fewer pages`],
  [/^未找到考察任务族：(.+)$/, (_, id) => `Assessment task family not found: ${id}`],
  [/^仍有 (\d+) 个启用中的考察任务族尚未完成三项校准确认（([\s\S]+)）$/, (_, n, list) => `${n} enabled assessment task famil${n === '1' ? 'y has' : 'ies have'} not completed the three calibration checks (${list.replaceAll('、', ', ')})`],
  [/^限时需为 (\d+)–(\d+) 分钟的整数$/, (_, min, max) => `The time limit must be a whole number of minutes from ${min} to ${max}`],
  [/^一次最多放入 (\d+) 张重点图片$/, (_, max) => `You can stage at most ${max} highlight images at once`],
  [/^转写请求被 Google 拒绝，已按顺序试了 (\d+) 种发送方式都不行。最初的原因：([\s\S]+?)(?:；最简请求的原因：([\s\S]+))?$/, (_, n, first, last) => `Google rejected the transcription request across all ${n} delivery modes tried. Initial reason: ${first}${last ? `; minimal request reason: ${last}` : ''}`],
  [/^校正结果无法解析（可能被截断）：([\s\S]+)$/, (_, err) => `The correction result could not be parsed (it may have been truncated): ${err}`],
  [/^本地识别引擎已退出（代码 (-?\d+)）\n([\s\S]+)$/, (_, code, detail) => `The local speech engine exited (code ${code})\n${detail}`],
  [/^校对与翻译的并发数应是 (\d+) 到 (\d+) 的整数$/, (_, min, max) => `Proofreading and translation concurrency must be a whole number from ${min} to ${max}`],
  [/^转写的并发数应是 (\d+) 到 (\d+) 的整数$/, (_, min, max) => `Transcription concurrency must be a whole number from ${min} to ${max}`],
  [/^每次请求最长的分钟数应是 (\d+) 到 (\d+) 的整数$/, (_, min, max) => `Longest per request must be an integer from ${min} to ${max} minutes`],
  [/^请选择 (\d+)–(\d+) 题一轮$/, (_, min, max) => `Choose a round of ${min}–${max} questions`],
  [/^请选择 1–(\d+) 道新题$/, (_, max) => `Choose 1–${max} new questions`],
  [/^(.+) 必须是 true 或 false$/, (_, name) => `${name} must be true or false`],
  [/^status 只能是 (.+)$/, (_, list) => `status must be one of ${list.replaceAll('、', ', ')}`],
  [/^等待时长需为 (\d+)–(\d+) 秒之间的整数$/, (_, min, max) => `Wait timeout must be a whole number of seconds from ${min} to ${max}`],
  [/^每批 (\d+)–(\d+) 道题$/, (_, min, max) => `Each batch must contain ${min}–${max} questions`],
  [/^练习题数应为 (\d+)–(\d+)$/, (_, min, max) => `Practice question counts must be ${min}–${max}`],
  // One-click upgrade failures (lib/update-install.js).
  [/^没有可一键安装的新版本。请改用手动升级：[\s\S]+$/, () => `No new version is available for one-click install. ${UPDATE_GUIDED_EN}`],
  [/^GitHub 下载失败（HTTP (\d+)）。请改用手动升级：[\s\S]+$/, (_, s) => `GitHub download failed (HTTP ${s}). ${UPDATE_GUIDED_EN}`],
  [/^(无法读取下载内容|下载的文件过大|发布页的校验清单里没有这个安装包，已停止升级|下载的安装包未通过 SHA-256 校验，已停止升级|当前 DSH 不支持在应用内安装插件)。请改用手动升级：[\s\S]+$/, (_, prefix) => `${UPDATE_PREFIX_EN[prefix]}. ${UPDATE_GUIDED_EN}`],
  [/^无法从 GitHub 下载新版本（(下载超时|网络不可用)）。稍后再试，或改用手动升级：[\s\S]+$/, (_, r) => `Cannot download the new version from GitHub (${r === '下载超时' ? 'download timed out' : 'network unavailable'}). Try again later, or ${UPDATE_GUIDED_EN[0].toLowerCase()}${UPDATE_GUIDED_EN.slice(1)}`],
  [/^DSH 没能安装新版本（([\s\S]+)）。请改用手动升级：[\s\S]+$/, (_, err) => `DSH could not install the new version (${err}). ${UPDATE_GUIDED_EN}`],
  // Interactive companion validation failure detail wrapper & system job title prefixes.
  [/^生成的交互伴学课经自动修复后仍未通过教学结构与公式校验。 \(([\s\S]+)\)$/, (_, detail) => `Generated lesson failed structural and pedagogical verification even after repair. (${detail})`],
  [/^交互伴学 · ([\s\S]+)$/, (_, topic) => `Interactive Companion · ${topic}`],
  [/^整理总纲 · ([\s\S]+)$/, (_, course) => `Organise the outline · ${course === '未分类课程' ? 'Uncategorised' : course}`],
  [/^生成复习全书 · ([\s\S]+)$/, (_, course) => `Write the review book · ${course === '未分类课程' ? 'Uncategorised' : course}`],
  [/^复习全书 · (弄懂|写一段|加一段|接着问) · ([\s\S]+)$/, (_, mode, title) => `Review book · ${{ 弄懂: 'Explain', 写一段: 'Write', 加一段: 'Add a paragraph', 接着问: 'Follow-up' }[mode]} · ${title}`],
  [/^答题卡 · (?:第 (\d+) 题 · )?([\s\S]+)$/, (_, n, prompt) => `Answer card · ${n ? `Q${n} · ` : ''}${prompt}`],
  [/^课堂校正 · ([\s\S]+)$/, (_, title) => `Live-class correction · ${title}`],
  [/^复核 · ([\s\S]+)$/, (_, title) => `Review · ${title}`],
  [/^补了 (\d+) 个词，检查题已排到这道题前面$/, (_, n) => `Filled in ${n} term${n === '1' ? '' : 's'}; check questions are queued before this card`],
  [/^补了 (\d+) 个词，但原题前置已满或无法关联，检查题保留在题组里$/, (_, n) => `Filled in ${n} term${n === '1' ? '' : 's'}, but the original card cannot link more prerequisites; check questions were saved in the deck`],
  [/^补了 (\d+) 个词，复用 (\d+) 个已有检查题，检查题已排到这道题前面$/, (_, n, r) => `Filled in ${n} term${n === '1' ? '' : 's'} and reused ${r} existing check question${r === '1' ? '' : 's'}; check questions are queued before this card`],
  [/^补了 (\d+) 个词，复用 (\d+) 个已有检查题，但原题前置已满或无法关联，检查题保留在题组里$/, (_, n, r) => `Filled in ${n} term${n === '1' ? '' : 's'} and reused ${r} existing check question${r === '1' ? '' : 's'}, but the original card cannot link more prerequisites; check questions were saved in the deck`],
  [/^复用 (\d+) 个已有检查题，已排到这道题前面（已跳过 (\d+) 个）$/, (_, r, s) => `Reused ${r} existing check question${r === '1' ? '' : 's'}; queued before this card (skipped ${s})`],
  [/^复用 (\d+) 个已有检查题，但原题前置已满或无法关联（已跳过 (\d+) 个）$/, (_, r, s) => `Reused ${r} existing check question${r === '1' ? '' : 's'}, but the original card cannot link more prerequisites (skipped ${s})`],
  [/^这几个词以前补过，检查题已排到这道题前面：([\s\S]+)$/, (_, list) => `These terms were already filled in earlier; their check questions are queued before this card: ${list.replaceAll('、', ', ')}`],
  [/^这几个词以前补过，但原题前置已满或无法关联，原有检查题保留在题组里：([\s\S]+)$/, (_, list) => `These terms were already filled in earlier, but the original card cannot link more prerequisites; existing check questions stay in the deck: ${list.replaceAll('、', ', ')}`],
  [/^没有可补的词：已跳过 (\d+) 个$/, (_, n) => `Nothing filled in: skipped ${n} marked item${n === '1' ? '' : 's'}`],
  [/^补词：([\s\S]+)$/, (_, list) => `Fill terms: ${list.replaceAll('、', ', ')}`],
  [/^(补齐词条|延伸词条)最多 (\d+) 个$/, (_, what, max) => `At most ${max} ${what === '补齐词条' ? 'marked terms' : 'deeper terms'} are allowed`],
  [/^台阶检查题缺少 ([a-z]+)$/, (_, field) => `Step check flashcard is missing ${field}`],
  [/^(.+?)格式无效，不能包含换行$/, (_, label) => `${termsLabels[label] || localizeAppMessage(label)} must be plain text without line breaks`],
  [/^(.+?)长度须在 1–(\d+) 字之间$/, (_, label, max) => `${termsLabels[label] || localizeAppMessage(label)} must be 1–${max} characters`],
  [/^(补齐词条|延伸词条|跳过词条|跳过原因|台阶词条|词条别名|台阶前置词条|问题说明|大白话说明|正式说法|具体例子|延伸词)格式无效$/, (_, label) => `${termsLabels[label] || label} has an invalid format`],
  [/^files 必须是至多 (\d+) 个音频文件的列表$/, (_, count) => `files must be a list of at most ${count} audio files`],
  // Bilingual "中文 / English" messages (book-*, course-book-*, exam-point-list, library operations): keep only the English half.
  [/^[^\n]*[\u4e00-\u9fff][^\n]*? \/ ((?:[A-Z]|未归位)[\s\S]+)$/, (whole, en) => { const clean = en.replaceAll('未归位', 'Not placed'); return /[\u4e00-\u9fff]/.test(clean) ? whole : clean; }],
];
const UPDATE_GUIDED_EN = 'Upgrade manually instead: copy the install specifier, remove the old version in DSH Plugin Manager, add it again, then restart DSH.';
const UPDATE_PREFIX_EN = {
  无法读取下载内容: 'Could not read the downloaded package',
  下载的文件过大: 'The downloaded package is too large',
  '发布页的校验清单里没有这个安装包，已停止升级': 'The release checksum list does not include this package; upgrade stopped',
  '下载的安装包未通过 SHA-256 校验，已停止升级': 'The downloaded package failed its SHA-256 check; upgrade stopped',
  '当前 DSH 不支持在应用内安装插件': 'This DSH cannot install plugins from inside the app',
};
const coachTag = tag => ({ 题干含糊: 'unclear stem', 答案存疑: 'questionable answer', 解析不清: 'unclear explanation', 超纲: 'out of scope', 太简单: 'too easy', 太难: 'too hard' })[tag] || tag;
const labels = { 笔记: 'Note', 目标题组: 'Target deck', 陪学记录: 'Coaching record', 学习流: 'Workflow', 学习记录: 'Study session',
  步骤名称: 'Step name', 流程名称: 'Workflow name', 流程说明: 'Workflow description', 学习主题: 'Study topic', 请求ID: 'Request ID', '请求 ID': 'Request ID', 学习目标: 'Study goal', 回答: 'Answer', 具体疑问: 'Specific question',
  说明: 'Explanation', 改题说明: 'Revision summary', 解答: 'Answer', 补充笔记: 'Supplementary note', 文章标题: 'Article title', 口头模拟: 'Oral mock exam', 'CSDN 公开主页': 'Public CSDN homepage',
  润色问题: 'Polished question', 推荐问题: 'Suggested question', 追问问题: 'Follow-up question', 前置阶段: 'Prerequisite stages', 关联阶段: 'Linked stages' };
const termsLabels = { 跳过词条: 'Skipped term', 跳过原因: 'Skip reason', 台阶词条: 'Ladder term', 词条别名: 'Term alias', 台阶前置词条: 'Step prerequisite',
  问题说明: 'Problem statement', 大白话说明: 'Plain-words explanation', 正式说法: 'Formal definition', 具体例子: 'Example', 补齐词条: 'Marked terms', 延伸词条: 'Deeper terms', 延伸词: 'Deeper term' };
const keyName = key => ({ 免费密钥: 'Free API key', 付费密钥: 'Paid API key', 'Groq 密钥': 'Groq API key', 硅基流动密钥: 'SiliconFlow API key', 密钥: 'API key' })[key];
const providerName = name => name === '硅基流动' ? 'SiliconFlow' : name;
const fallbackKey = key => key === '付费密钥' ? 'the paid API key' : providerName(key.trim());
/** What lib/audio-ogg.js could not read in an Ogg file. */
const oggDetail = detail => ({ '开头没有 OggS': 'it does not start with OggS', '页的版本号不是 0': 'a page has a version other than 0', 头信息不完整: 'the headers are incomplete',
  没有音频数据: 'there is no audio data', '采样率为 0': 'the sample rate is 0' })[detail]
  ?? detail.replace(/^第 (\d+) 页的开头不对$/, (_, page) => `page ${page} does not start where it should`);

/** Translate exact application messages; unknown/provider prose and interpolated user values stay intact. */
/** English parts of one message joined with "; ": a part that starts with an ordinary word carries on the sentence in lower case. */
const CONTINUING_WORD = /^(About|The|A|An|Connection|Autosave|Audio|Local|Page)\b/;
const joinParts = parts => parts.map((part, index) => (index && CONTINUING_WORD.test(part) ? part[0].toLowerCase() + part.slice(1) : part)).join('; ');
/** A message lib/live.js joined from several parts with ；: each part (or the shortest run of parts the table knows as one message, since some of them hold a ； themselves) in English. */
function localizeJoined(text) {
  const parts = text.split('；');
  if (parts.length < 2) return text;
  const known = candidate => (Object.hasOwn(english, candidate) ? english[candidate] : templates.some(([pattern]) => pattern.test(candidate)) ? localizeAppMessage(candidate) : undefined);
  const out = [];
  for (let start = 0; start < parts.length;) {
    let end = start + 1, translated;
    for (; end <= parts.length && translated === undefined; end += 1) translated = known(parts.slice(start, end).join('；'));
    if (translated === undefined) { out.push(parts[start]); start += 1; } else { out.push(translated); start = end - 1; }
  }
  return out.some((part, index) => part !== parts[index]) ? joinParts(out) : text;
}

export function localizeAppMessage(text, language = 'en') {
  if (language !== 'en' || typeof text !== 'string') return text;
  // Old persisted notices keep their earlier page/settings names.
  const current = text.replaceAll('音频转录', '音频转写').replaceAll('设置 › 扩展：文档转换与检索', '设置 › 检索扩展')
    .replaceAll('设置 › 扩展', '设置 › 检索扩展').replaceAll('设置 › MinerU 云端解析', '设置 › PDF 转换（MinerU）');
  if (current !== text && Object.hasOwn(english, current)) return english[current];
  if (Object.hasOwn(english, text)) return english[text];
  if (Object.hasOwn(labels, text)) return labels[text];
  for (const [pattern, format] of templates) { const match = text.match(pattern); if (match) return format(...match); }
  return text.includes('；') ? localizeJoined(text) : text;
}

const proseFields = ['stage', 'message', 'error', 'note', 'next', 'summary'];
const localizeFields = (value, fields = proseFields) => {
  if (!value || typeof value !== 'object') return value;
  const result = { ...value };
  for (const field of fields) if (typeof result[field] === 'string') result[field] = localizeAppMessage(result[field]);
  if (Array.isArray(result.warnings)) result.warnings = result.warnings.map(text => localizeAppMessage(text));
  return result;
};
const SYSTEM_JOB_TITLE_RE = /^(?:交互伴学|整理总纲|生成复习全书|复习全书 · (?:弄懂|写一段|加一段|接着问)|答题卡|课堂校正|复核|建立检索索引|检索索引) · /;
/** The prose of a job's contract (docs/job-contract.md) in English: the producer's own words, nothing the panel translates by code. */
const contractView = contract => {
  const result = { ...contract };
  if (typeof result.title === 'string' && (Object.hasOwn(english, result.title) || SYSTEM_JOB_TITLE_RE.test(result.title))) {
    result.title = localizeAppMessage(result.title);
  }
  if (result.stage?.text) result.stage = { ...result.stage, text: localizeAppMessage(result.stage.text) };
  if (result.error?.message) result.error = { ...result.error, message: localizeAppMessage(result.error.message) };
  if (Array.isArray(result.calls)) result.calls = result.calls.map(call => (typeof call.stage === 'string' ? { ...call, stage: localizeAppMessage(call.stage) } : call));
  if (Array.isArray(result.events)) result.events = result.events.map(event => (typeof event?.text === 'string' ? { ...event, text: localizeAppMessage(event.text) } : event));
  if (result.detail && typeof result.detail === 'object') {
    let detail = result.detail;
    if (Array.isArray(detail.notices)) detail = { ...detail, notices: detail.notices.map(notice => ({ ...notice, text: localizeAppMessage(notice.text) })) };
    if (Array.isArray(detail.batches)) detail = { ...detail, batches: detail.batches.map(batch => (typeof batch?.message === 'string' && batch.message ? { ...batch, message: localizeAppMessage(batch.message) } : batch)) };
    if (typeof detail.note === 'string' && detail.note) detail = { ...detail, note: localizeAppMessage(detail.note) };
    if (typeof detail.failure?.summary === 'string') detail = { ...detail, failure: { ...detail.failure, summary: localizeAppMessage(detail.failure.summary) } };
    result.detail = detail;
  }
  return result;
};
const jobView = job => {
  const result = localizeFields(job);
  if (result?.contract) result.contract = contractView(result.contract);
  if (typeof result?.failure?.summary === 'string') result.failure = { ...result.failure, summary: localizeAppMessage(result.failure.summary) };
  if (result?.error && typeof result.error === 'object' && typeof result.error.message === 'string') {
    result.error = { ...result.error, message: localizeAppMessage(result.error.message) };
  }
  if (Array.isArray(result?.problems)) {
    result.problems = result.problems.map(problem => (typeof problem?.message === 'string' ? { ...problem, message: localizeAppMessage(problem.message) } : problem));
  }
  if (typeof result?.label === 'string') {
    const mapped = localizeAppMessage(result.label);
    result.label = mapped !== result.label ? mapped : result.label.replace(/^(帮我弄懂|提升质量|出成题|补齐生词) · /, (_, mode) => `${localizeAppMessage(mode)} · `);
  }
  for (const field of ['members', 'tasks', 'steps', 'chunks', 'calls']) if (Array.isArray(result?.[field])) result[field] = result[field].map(jobView);
  // The log's lines carry the producer's prose in `text`; the codes and arguments are translated by the panel.
  if (Array.isArray(result?.events)) result.events = result.events.map(event => (typeof event?.text === 'string' ? { ...event, text: localizeAppMessage(event.text) } : event));
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
const inboxDetail = (item, detail) => {
  if (typeof detail !== 'string' || !detail) return detail;
  if (isJobKind(item.kind)) return localizeAppMessage(detail);
  if (item.kind === 'note') {
    return localizeAppMessage(detail)
      .replace(/^笔记草稿「(.+)」已生成，请审阅后发布$/, (_, title) => `Note draft "${title}" was generated; review it before publishing`)
      .replace(/^「(.+)」今日学习总结已(生成|整理)，可直接阅读$/, (_, course, verb) => `Today's study recap for "${course}" is ${verb === '生成' ? 'ready' : 'updated'} to read`);
  }
  if (item.kind === 'improve') {
    return localizeAppMessage(detail)
      .replace(/^对话批量改进了 (\d+) 道题$/, (_, count) => `Improved ${count} questions in chat`);
  }
  if (item.kind === 'link') {
    return localizeAppMessage(detail)
      .replace(/^关联前置题：/, 'Linked prerequisite: ')
      .replace(/^新增前置题：/, 'Added prerequisite: ');
  }
  if (item.kind === 'passage-added') {
    return detail.replace(/^补入 (\d+) 张到「(.+)」(?:，(\d+) 张未通过审阅)?$/, (_, added, title, rejected) => `Added ${added} to "${title}"${rejected ? `; ${rejected} did not pass review` : ''}`);
  }
  if (item.kind === 'coach') return localizeAppMessage(detail).replace(/^换个角度再讲：/, 'Another explanation: ');
  if (item.kind === 'variant') return localizeAppMessage(detail).replace(/^备好定制题：/, 'Personalised question ready: ');
  if (item.kind === 'rewrite') return localizeAppMessage(detail).replace(/^核对后未改动：/, 'Checked — no change needed: ');
  return localizeAppMessage(detail);
};
const inboxView = inbox => inbox && ({ ...inbox, items: inbox.items?.map(item => ({ ...item, label: localizeAppMessage(item.label),
  ...(isJobKind(item.kind) ? { deckTitle: localizeAppMessage(item.deckTitle) } : {}),
  ...(item.detail === undefined ? {} : { detail: inboxDetail(item, item.detail) }),
  ...(item.detailFull === undefined ? {} : { detailFull: inboxDetail(item, item.detailFull) }) })) });
const noteView = note => note?.generation ? { ...note, generation: localizeFields(note.generation) } : note;
const workflowView = session => session && ({ ...session, ...(session.skeletonJob ? { skeletonJob: localizeFields(session.skeletonJob) } : {}),
  ...(session.records ? { records: Object.fromEntries(Object.entries(session.records).map(([id, record]) => [id,
    record.teaching ? { ...record, teaching: localizeFields(record.teaching, ['message', 'error']) } : record])) } : {}) });
const liveView = session => {
  const result = jobView(session);
  if (session?.inputAudio?.error) result.inputAudio = { ...session.inputAudio, error: localizeAppMessage(session.inputAudio.error) };
  if (session?.correction) result.correction = { ...session.correction, error: localizeAppMessage(session.correction.error),
    ...(session.correction.background ? { background: { ...session.correction.background, tasks: session.correction.background.tasks?.map(jobView) } } : {}) };
  return result;
};

const sourceTitleView = source => {
  if (!source || typeof source.title !== 'string') return source;
  let title = source.title;
  if (source.provenance === 'json-card-self-reference' && !source.provenanceInferred) title = title.replace(/^JSON 导入：/, 'JSON import: ');
  if (source.origin === 'capture') title = title.replace(/^补充笔记 · /, 'Supplementary notes · ');
  if (source.live?.sessionId) title = title.replace(/ · 片段 ((?:\d+:)?\d{2}:\d{2}–(?:\d+:)?\d{2}:\d{2})$/, ' · Excerpt $1');
  return title === source.title ? source : { ...source, title };
};
const deckTitleView = deck => {
  if (!deck || typeof deck.title !== 'string') return deck;
  if (deck.systemKind === 'coach' && deck.title === '为你定制') return { ...deck, title: 'Personalised' };
  if (deck.companionCatchup && deck.title === '伴学拾遗') return { ...deck, title: 'Companion Catch-ups' };
  if (deck.companionDeck && deck.title.endsWith(' · 伴学口述与演练')) return { ...deck, title: deck.title.replace(/ · 伴学口述与演练$/, ' · Oral & Lab Drills') };
  return deck;
};
const companionTitleText = text => (typeof text === 'string' && text.startsWith('交互伴学 · ')
  ? `Interactive Companion · ${text.slice('交互伴学 · '.length)}` : text);
const companionRecordView = item => {
  if (!item || typeof item.title !== 'string') return item;
  const title = companionTitleText(item.title);
  return title === item.title ? item : { ...item, title };
};
const courseRecordView = course => {
  if (!course || !Array.isArray(course.companions)) return course;
  const next = course.companions.map(companionRecordView);
  return next.every((item, index) => item === course.companions[index]) ? course : { ...course, companions: next };
};
const localizeCompanionDeckName = name => {
  if (typeof name !== 'string') return name;
  if (name === '伴学拾遗') return 'Companion Catch-ups';
  if (name.endsWith(' · 伴学口述与演练')) return `${name.slice(0, -' · 伴学口述与演练'.length)} · Oral & Lab Drills`;
  return name;
};
const runRecordView = (run, companionDeckIds) => {
  if (!run || typeof run !== 'object') return run;
  const ids = [run.deckId, ...(Array.isArray(run.deckIds) ? run.deckIds : [])].filter(Boolean);
  if (companionDeckIds && !ids.some(id => companionDeckIds.has(id))) return run;
  let nextTitle = typeof run.title === 'string' ? localizeCompanionDeckName(run.title) : run.title;
  if (typeof nextTitle === 'string') {
    nextTitle = nextTitle.replace(/^伴学拾遗(?=(?: › | 等 ))/, 'Companion Catch-ups')
      .replace(/ · 伴学口述与演练(?=(?: › | 等 ))/, ' · Oral & Lab Drills');
  }
  let nextInfo = run.titleInfo;
  if (nextInfo && Array.isArray(nextInfo.values) && nextInfo.values.length) {
    const vals = [localizeCompanionDeckName(nextInfo.values[0]), ...nextInfo.values.slice(1)];
    if (vals[0] !== nextInfo.values[0]) nextInfo = { ...nextInfo, values: vals };
  }
  return nextTitle === run.title && nextInfo === run.titleInfo
    ? run
    : { ...run, title: nextTitle, ...(nextInfo !== run.titleInfo ? { titleInfo: nextInfo } : {}) };
};
const coachStatusView = status => status && typeof status === 'object' ? {
  ...status,
  ...(Array.isArray(status.failedCards) ? { failedCards: status.failedCards.map(item => (typeof item?.message === 'string' ? { ...item, message: localizeAppMessage(item.message) } : item)) } : {}),
  ...(Array.isArray(status.tasks) ? { tasks: status.tasks.map(task => ({
    ...task,
    ...(typeof task?.label === 'string' ? { label: localizeAppMessage(task.label) } : {}),
    ...(typeof task?.message === 'string' && task.message ? { message: localizeAppMessage(task.message) } : {}),
  })) } : {}),
} : status;
const coachResponseView = value => {
  let result = Array.isArray(value.tasks) || Array.isArray(value.failedCards) ? coachStatusView(value) : value;
  if (value.status && typeof value.status === 'object') result = { ...result, status: coachStatusView(value.status) };
  if (typeof value.reverted === 'string') result = { ...result, reverted: localizeAppMessage(value.reverted) };
  return result;
};

/** Project owned response metadata and generated title labels; user prose and identifiers remain intact. */
export function localizeAppResponse(value, action, language) {
  if (language !== 'en' || !value || typeof value !== 'object' || Array.isArray(value) || action === 'state.read') return value;
  let result = value;
  if (action === 'snapshot') {
    const companionDeckIds = Array.isArray(value.decks)
      ? new Set(value.decks.filter(d => d?.companionCatchup || d?.companionDeck).map(d => d.id).filter(Boolean))
      : null;
    result = { ...value, ...(value.jobs ? { jobs: value.jobs.map(jobView) } : {}), ...(value.archivedJobs ? { archivedJobs: value.archivedJobs.map(jobView) } : {}), ...(value.inbox ? { inbox: inboxView(value.inbox) } : {}),
      ...(value.sources ? { sources: value.sources.map(sourceTitleView) } : {}), ...(value.decks ? { decks: value.decks.map(deckTitleView) } : {}),
      ...(value.courses ? { courses: value.courses.map(courseRecordView) } : {}),
      ...(value.runs ? { runs: value.runs.map(run => runRecordView(run, companionDeckIds)) } : {}),
      ...(value.lastRun ? { lastRun: runRecordView(value.lastRun, companionDeckIds) } : {}),
      ...(value.coach ? { coach: coachStatusView(value.coach) } : {}) };
    if (value.assist) result.assist = value.assist.map(jobView);
    if (value.notes) result.notes = value.notes.map(noteView);
  } else if (action.startsWith('coach.')) result = coachResponseView(value);
  else if (action === 'source.get') result = sourceTitleView(value);
  else if (action === 'source.list') result = { ...value, ...(value.sources ? { sources: value.sources.map(sourceTitleView) } : {}) };
  else if (action === 'deck.get') result = deckTitleView(value);
  else if (action === 'companion.list') result = Array.isArray(value.companions) ? { ...value, companions: value.companions.map(companionRecordView) } : value;
  else if (['companion.get', 'companion.attach', 'companion.sync', 'companion.compile'].includes(action)) {
    result = value.companion ? { ...value, companion: companionRecordView(value.companion) } : value;
  } else if (action === 'companion.catchup.save') {
    const deckTitle = localizeCompanionDeckName(value.deckTitle);
    result = deckTitle === value.deckTitle ? value : { ...value, deckTitle };
  } else if (action.startsWith('oral.')) {
    result = {
      ...value,
      ...(value.entry?.topic === '未分类' ? { entry: { ...value.entry, topic: 'Uncategorized' } } : {}),
      ...(Array.isArray(value.entries) ? { entries: value.entries.map(item => (item?.topic === '未分类' ? { ...item, topic: 'Uncategorized' } : item)) } : {}),
      ...(Array.isArray(value.weakTopics) ? { weakTopics: value.weakTopics.map(row => (row?.topic === '未分类' ? { ...row, topic: 'Uncategorized' } : row)) } : {}),
    };
  } else if (action === 'inbox') result = inboxView(value);
  else if (action === 'jobs' || action.startsWith('job.') || /^(audio\.|live\.|mineru\.|draft\.(publish|repair)\.start|generate|generation\.|companion\.build|supplement|selection\.|assist\.|source\.folder\.classify|source\.organize\.start)/.test(action)) {
    result = jobView(value);
    if (Array.isArray(value.jobs)) result.jobs = value.jobs.map(jobView);
    if (value.job && typeof value.job === 'object') result.job = jobView(value.job);
    // The conversion history (mineru.history.list): a failure's reason is a sentence of the backend's own.
    if (Array.isArray(value.records)) result.records = value.records.map(record => record.failure?.reason ? { ...record, failure: { ...record.failure, reason: localizeAppMessage(record.failure.reason) } } : record);
    if (action === 'audio.test') for (const tier of ['free', 'paid', 'groq', 'siliconflow']) if (value[tier]) result[tier] = localizeFields(value[tier]);
    if (action.startsWith('live.')) { result = liveView(value); if (value.sessions) result.sessions = value.sessions.map(liveView); }
  } else if (action.startsWith('workflow.')) {
    result = { ...value, ...(value.session ? { session: workflowView(value.session) } : {}) };
    if (value.sessions) result.sessions = value.sessions.map(workflowView);
    if (value.records || value.skeletonJob) result = workflowView(result);
  } else if (action.startsWith('note.')) {
    result = localizeFields(noteView(value), ['reason']);
    if (value.notes) result.notes = value.notes.map(noteView);
  } else if (action === 'card.grade') {
    result = localizeFields(value, ['message']);
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
