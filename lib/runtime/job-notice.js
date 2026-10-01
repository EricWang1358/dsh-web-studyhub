export function createJobNotifier(notify) {
function announceJob(job) {
    if (!notify) return;
    const title = job.deckTitle || "题组";
    const done = job.status === "complete";
    if (job.type === 'supplement') {
      const receipt = job.publication;
      try {
        notify({ summary: `「${job.targetTitle}」${done ? `补入 ${receipt.added} 题 · 共 ${receipt.total} 题` : '补题未完成'}`,
          text: `学习插件补题结果：任务 ${job.id} 状态 ${job.status}，目标题组 ${job.mergeTargetId}「${job.targetTitle}」。${job.stage}。` +
            (receipt ? `实际新增 ${receipt.added}，总数 ${receipt.total ?? '未变'}。` : '未确认有题目并入，请勿报告成功。') +
            (receipt?.remainingDraftId ? `未通过的题目保留在 ${receipt.remainingDraftId}，未并入。` : '') +
            (job.savedCount < job.requestedTotal ? `生成通过 ${job.savedCount || 0}/${job.requestedTotal}，未补足请求数量。` : '') +
            '只报告结果和必要阻塞原因；用户补入授权仍有效，不再询问是否发布，不自动重跑。' });
      } catch { /* the panel retains the result */ }
      return;
    }
    if (job.type === "audio-import") {
      try {
        notify({
          summary: `音频「${job.filename}」${done ? "已转写成中英对照逐字稿" : job.status === "cancelled" ? "导入已取消" : "导入未完成"}`,
          text: `学习插件通知：音频 ${job.filename} 的导入任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
            (done && job.sourceIds?.length ? `逐字稿已存为资料 ${job.sourceIds.join("、")}，可在资料页核对；要出题时再用 generate，本次没有自动出题。` : ""),
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    if (job.type === "draft-publish") {
      try {
        notify({
          summary: `「${title}」${done ? "发布检查完成" : "发布未完成"}`,
          text: `学习插件通知：题组「${title}」的发布任务 ${job.id} 状态 ${job.status}。${job.stage}。`,
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    if (job.type === "draft-repair") {
      try {
        notify({
          summary: `「${title}」后台修题${done ? "全部通过" : job.status === "cancelled" ? "已取消"
            : job.savedCount ? "部分通过" : "未修好"} · ${job.savedCount}/${job.count} 题`,
          text: `学习插件通知：题组「${title}」的后台修题任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
            `通过的题目留在草稿 ${job.draftId}，学习者可回到草稿把它们加入原题组；没有自动发布。`,
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    const summary = done
      ? `「${title}」生成完成 · ${job.savedCount ?? job.count} 题草稿待发布`
      : `「${title}」生成${job.status === "cancelled" ? "已取消" : "未完成"}：${job.stage}`;
    // Called from a job's finally: a notifier that throws must not disturb it.
    try {
      notify({
        summary,
        text:
          `学习插件通知（后台生成结束，学习者没有开口）：题组「${title}」的生成任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
          (job.draftId ? `草稿 ${job.draftId} 已保存，${job.savedCount ?? 0}/${job.requestedTotal ?? job.count} 题通过审核，学习者可在学习面板的草稿里审阅或发布。` : "没有产出草稿。") +
          "下次回复时顺带把结果告诉学习者；不要因此重新发起生成，也不要轮询任务状态。",
      });
    } catch {
      /* the session is gone; the study panel still shows the job */
    }
  }
return announceJob;
}
