import { localizeAppMessage } from '../application-messages.js';

export function createJobNotifier(notify) {
  return function announceJob(job) {
    if (!notify) return;
    const english = job.language === 'en';
    const title = job.deckTitle || (english ? 'Deck' : '题组');
    const done = job.status === 'complete';
    const cancelled = job.status === 'cancelled';
    const stage = english ? localizeAppMessage(job.stage) : job.stage;
    let summary, text;

    if (job.type === 'audio-import') {
      const result = done ? (english ? 'saved as a bilingual transcript' : '已转写成中英对照逐字稿')
        : cancelled ? (english ? 'import cancelled' : '导入已取消') : (english ? 'import incomplete' : '导入未完成');
      const transcriptSaved = done && job.sourceIds?.length;
      summary = english ? `Audio "${job.filename}" ${result}` : `音频「${job.filename}」${result}`;
      text = english
        ? `Study notification: audio import ${job.id} for ${job.filename} has status ${job.status}. ${stage}.` +
          (transcriptSaved ? ` The transcript is saved in Sources (${job.sourceIds.join(', ')}). Verify it there; generate questions separately. This import did not generate questions automatically.` : ' Completed work is retained.')
        : `学习插件通知：音频 ${job.filename} 的导入任务 ${job.id} 状态 ${job.status}。${stage}。` +
          (transcriptSaved ? `逐字稿已存为资料 ${job.sourceIds.join('、')}，可在资料页核对；要出题时再用 generate，本次没有自动出题。` : '');
    } else if (job.type === 'pdf-convert') {
      const result = done ? (english ? 'converted and saved as material' : '已转换并存为资料')
        : cancelled ? (english ? 'conversion cancelled' : '转换已取消') : (english ? 'conversion incomplete' : '转换未完成');
      summary = english ? `PDF "${job.filename}" ${result}` : `PDF「${job.filename}」${result}`;
      text = english
        ? `Study notification: PDF conversion ${job.id} for ${job.filename} has status ${job.status}. ${stage}.` +
          (done && job.sourceIds?.length ? ` It is saved in Sources (${job.sourceIds.length} pages). Generate questions separately; this import did not generate any.` : ' Finished pieces are retained.')
        : `学习插件通知：PDF ${job.filename} 的云端转换任务 ${job.id} 状态 ${job.status}。${stage}。` +
          (done && job.sourceIds?.length ? `已存为资料（${job.sourceIds.length} 页），可在资料页核对；要出题时再用 generate，本次没有自动出题。` : '已完成的段落已保留。');
    } else if (job.type === 'supplement') {
      const receipt = job.publication;
      const result = done && receipt
        ? (english ? `${receipt.added} questions added · ${receipt.total} total` : `补入 ${receipt.added} 题 · 共 ${receipt.total} 题`)
        : (english ? 'supplement incomplete' : '补题未完成');
      const addition = receipt
        ? (english ? `Actually added ${receipt.added}; total ${receipt.total ?? 'unchanged'}. ` : `实际新增 ${receipt.added}，总数 ${receipt.total ?? '未变'}。`)
        : (english ? 'No addition is confirmed; do not report success. ' : '未确认有题目并入，请勿报告成功。');
      const remaining = receipt?.remainingDraftId
        ? (english ? `Unapproved questions remain in draft ${receipt.remainingDraftId} and were not merged. ` : `未通过的题目保留在 ${receipt.remainingDraftId}，未并入。`) : '';
      const shortfall = job.savedCount < job.requestedTotal
        ? (english ? `${job.savedCount || 0}/${job.requestedTotal} requested questions passed generation checks. ` : `生成通过 ${job.savedCount || 0}/${job.requestedTotal}，未补足请求数量。`) : '';
      summary = english ? `"${job.targetTitle}" ${result}` : `「${job.targetTitle}」${result}`;
      text = (english
        ? `Study supplement result: task ${job.id}, status ${job.status}, target ${job.mergeTargetId} "${job.targetTitle}". ${stage}. `
        : `学习插件补题结果：任务 ${job.id} 状态 ${job.status}，目标题组 ${job.mergeTargetId}「${job.targetTitle}」。${stage}。`) +
        addition + remaining + shortfall + (english
        ? 'Report the result and necessary blockers only. The learner’s authorization remains valid; do not ask again whether to publish or rerun automatically.'
        : '只报告结果和必要阻塞原因；用户补入授权仍有效，不再询问是否发布，不自动重跑。');
    } else if (job.type === 'translation') {
      const kept = job.savedCount ?? 0, total = job.total ?? kept, title = job.targetTitle || (english ? 'the material' : '这份资料');
      const result = done ? (english ? `${kept}/${total} paragraphs translated` : `已译 ${kept}/${total} 段`)
        : cancelled ? (english ? 'stopped' : '已停止') : (english ? 'incomplete' : '未完成');
      summary = english ? `Translation of "${title}": ${result}` : `「${title}」${result}`;
      text = english
        ? `Study notification: translation task ${job.id} for "${title}" has status ${job.status}. ${stage}. Translated paragraphs are kept in the reader; do not restart the translation or poll the task.`
        : `学习插件通知：资料「${title}」的翻译任务 ${job.id} 状态 ${job.status}。${stage}。已译好的段落保留在阅读器里；不要重新发起翻译，也不要轮询任务状态。`;
    } else if (job.type === 'draft-publish') {
      const result = done ? (english ? 'checks complete' : '发布检查完成') : (english ? 'incomplete' : '发布未完成');
      summary = english ? `"${title}" publication ${result}` : `「${title}」${result}`;
      text = english
        ? `Study notification: publication task ${job.id} for "${title}" has status ${job.status}. ${stage}.`
        : `学习插件通知：题组「${title}」的发布任务 ${job.id} 状态 ${job.status}。${stage}。`;
    } else if (job.type === 'draft-repair') {
      const result = done ? (english ? 'approved' : '全部通过') : cancelled ? (english ? 'cancelled' : '已取消')
        : job.savedCount ? (english ? 'partially approved' : '部分通过') : (english ? 'incomplete' : '未修好');
      summary = english
        ? `"${title}" background repair ${result} · ${job.savedCount}/${job.count} questions`
        : `「${title}」后台修题${result} · ${job.savedCount}/${job.count} 题`;
      text = english
        ? `Study notification: repair task ${job.id} for "${title}" has status ${job.status}. ${stage}. Approved questions remain in draft ${job.draftId}; the learner can add them to the original deck from Drafts. Nothing was published automatically.`
        : `学习插件通知：题组「${title}」的后台修题任务 ${job.id} 状态 ${job.status}。${stage}。` +
          `通过的题目留在草稿 ${job.draftId}，学习者可回到草稿把它们加入原题组；没有自动发布。`;
    } else {
      const result = done
        ? (english ? `complete · ${job.savedCount ?? job.count} draft questions awaiting publication` : `完成 · ${job.savedCount ?? job.count} 题草稿待发布`)
        : cancelled ? (english ? 'cancelled' : `已取消：${stage}`) : (english ? 'incomplete' : `未完成：${stage}`);
      summary = english ? `"${title}" generation ${result}` : `「${title}」生成${result}`;
      const draft = job.draftId
        ? (english ? `Draft ${job.draftId} was saved; ${job.savedCount ?? 0}/${job.requestedTotal ?? job.count} questions passed review. The learner can review or publish it from Drafts. `
          : `草稿 ${job.draftId} 已保存，${job.savedCount ?? 0}/${job.requestedTotal ?? job.count} 题通过审核，学习者可在学习面板的草稿里审阅或发布。`)
        : (english ? 'No draft was produced. ' : '没有产出草稿。');
      // A short draft says how many parts passed and why, and that the missing questions are topped up, not redone by hand (lib/generation-report.js).
      const short = job.draftId && job.partReport?.summary && (job.savedCount ?? 0) < (job.requestedTotal ?? job.count);
      const topUp = short ? (english
        ? `${job.partReport.summary} The questions that passed are kept; offer the learner a top-up of the missing ones (the Continue generation button on the draft, or generate with resumeDraftId ${job.draftId}) instead of asking them to select fewer pages and start over. `
        : `${job.partReport.summary}通过的题已保留；可以提议用「继续补齐」（草稿上的按钮，或 generate 的 resumeDraftId ${job.draftId}）补上缺的题，不必让学习者少选几页重新来。`) : '';
      text = (english
        ? `Study notification: background generation task ${job.id} for "${title}" has status ${job.status}. ${stage}. `
        : `学习插件通知（后台生成结束，学习者没有开口）：题组「${title}」的生成任务 ${job.id} 状态 ${job.status}。${stage}。`) +
        draft + topUp + (english ? 'Mention the result in the next reply; do not restart generation or poll the task.'
          : '下次回复时顺带把结果告诉学习者；不要因此重新发起生成，也不要轮询任务状态。');
    }

    // Called from a job's finally: a notifier that throws must not disturb it.
    try { notify({ summary, text }); } catch { /* the panel retains the result */ }
  };
}
