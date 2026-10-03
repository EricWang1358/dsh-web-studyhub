# Add questions to an existing deck

[中文](supplementation.zh-CN.md)

Ask in the main chat to fill the gaps in a deck you already have. For example: "Add the concepts from this week's lecture notes that the Midterm deck doesn't cover yet."

The agent starts one background task. It writes questions from your sources, has them reviewed independently, and adds the ones that pass to that deck. Asking to add questions to a named deck already allows StudyHub to save them, so you are not asked to confirm each step.

## Before you start

- **A working model.** Writing and reviewing use the model StudyHub uses for generating questions. Model calls are billed by your provider.
- **A target deck.** It must be an ordinary deck that is not archived. System decks, such as the retired deck and the **Personalised** deck, cannot receive questions.
- **Sources.** Name the sources to draw from. Together they can hold up to 600,000 characters. With the search extension installed, StudyHub can first narrow a larger selection to the pages that match your focus. See [Large textbooks](large-documents.md).
- **Question types.** Any type except a case paper.

## Ask for questions

1. In the main chat, name the deck and the sources, and say what is missing.
2. The agent compares the sources with the questions already in the deck. It then picks the gaps and the number of questions to add: 1–30 per task.
3. Follow the task on its card at the top of the **Study library** page. Click **Stop** to cancel it.

When the task ends, the main chat gets one notice with the number of questions actually added and the deck's new total.

## Read the result

The task card's headline, followed by the deck name, tells you where the task stands:

| Headline | Meaning |
| --- | --- |
| **Supplement queued** | Waiting for an earlier task to finish. |
| **Reviewing and adding questions to the deck** | Writing, reviewing or adding questions. |
| **Added N questions · M total** | Every requested question passed and was added. |
| **Partially added N questions · M total** | Some questions were added. The rest were rejected or never written. |
| **Supplement incomplete** | Nothing was added. The card says why. |
| **Stopping supplementation** | You clicked **Stop**, or the time budget ran out, and the task is shutting down. |
| **Supplement cancelled** | You stopped the task. |

Only questions that were saved into the deck count as added. A question that was written or accepted but not saved is not reported as added.

## What happens to your deck

- Questions that pass review join the deck itself. No new deck is created.
- Existing questions keep their IDs, review schedules and answer history.
- If every question is added, the task's working draft is deleted.
- If some questions are left over, they stay in a draft with the reason each one was rejected. Open it from the task card with **Open draft**.

## Limits and failures

- **One review per batch.** Each batch gets one independent review. Accepted questions are kept and rejected ones are dropped with their reasons. StudyHub does not keep repairing or regenerating questions to reach the requested number.
- **Time budget.** A task may run for 20 minutes by default, not counting time in the queue. Change this with **Time budget (minutes)** in **Settings › Question defaults**. When a task runs out of time, questions that were already saved and reviewed, and not changed since, are still added. This step makes no further model call. The notice reports how many are missing.
- **Stopping wins.** If you stop the task, nothing more is added, even at the end of the budget.
- **Changes block publication.** If the deck is archived or edited, or a question changes while the task runs, the affected questions are not added.
- **No automatic retry.** A task that fails because the deck was removed or archived, because of a conflict, a cancellation or a failed review does not restart. It never falls back to another deck. Unfinished work stays in a draft that can be resumed.
- **Nothing passes, nothing changes.** If no question passes, the task fails and the deck stays as it was.

## Other ways to add questions

- **From one passage:** select text in a source's reader and use **Add to an existing deck**.
- **As a draft you check first:** **Create deck** › **Generate from sources** writes a draft. You review it and choose when to publish.

## For agents and developers

Call `supplement` through `study_workspace`:

```json
{"action":"supplement","payload_json":"{\"deckId\":\"complete-target-deck-id\",\"sourceIds\":[\"source-id\"],\"count\":5,\"kind\":\"flashcard\",\"focus\":\"Missing concepts confirmed by comparison with existing questions\"}"}
```

| Field | Notes |
| --- | --- |
| `deckId` | Required. The full ID of an existing, unarchived ordinary deck. |
| `sourceIds` | Required. The sources to write from. |
| `count` | 1–30. |
| `kind` | `quiz`, `multi`, `flashcard`, `open`, `cloze` or `mixed`. `case` is refused. |
| `focus`, `language`, `difficulty`, `constraints` | Optional, as for `generate`. |
| `resumeDraftId`, `draftVersion` | Resume a partial job from its draft. The draft's target must equal `deckId`, and `draftVersion` must be current. |

Choose what to add from evidence:

- Compare the sources with the target's actual questions before choosing gaps, counts and prerequisites. Use `source.coverage` and `card.search` with exact scopes.
- `source.coverage` direct-citation counts help locate evidence. They do not measure whether a concept is covered.
- A number in a deck title is not a question count.
- Save explicit prerequisite relationships with `capture.requiredBy` or `card.link`. Do not invent them.

How the job behaves:

- A request to add questions to a named deck authorises local generation, review and publication. Do not ask again whether to publish.
- Generation and review stage JSON is collected by the plugin and is not injected into the conversation.
- `generate` still creates a draft only and never publishes on its own.
- The final receipt carries `publication.deckId`, `added`, `total` and `remainingDraftId`. Report committed additions only. A queued or accepted question is not an added one.
- `job.wait {jobId?, timeoutSeconds?}` allows one bounded wait of up to 60 seconds to finish an authorised request. The learner does not need to ask you to wait. On timeout, return control; the final notification reports the result. Do not poll in a loop or enqueue duplicates.
