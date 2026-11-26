# Windows tool and file assumptions (class C15)

Long-tail traps where a command, test or edit assumed Unix behaviour on the owner's Windows machine or the Windows CI shards. Search this file when a script, test or edit behaves differently on Windows.

| Trap | What happened | Do instead |
|---|---|---|
| Temp paths have two spellings | A test compared an 8.3 short temp path with its long spelling and failed on Windows CI (#52). | Resolve both sides with `fs.realpathSync.native` before comparing paths. |
| System `tar` is not GNU tar | Rollback drills piped `git archive` into the system `tar`, which rejected the stream on Windows (#357). | Extract with a Node library or `git archive --output` plus a cross-platform extractor; never shell out to `tar` in tests. |
| Whole-file line-ending rewrite | An edit script normalised a CRLF file to LF, turning a six-line change into a ~900-line diff (#810). | Before editing, count CRLF vs LF bytes; write back with the file's own line ending; check `git diff --stat` before committing. |
| Windows PowerShell 5.1 | `&&` is a parser error, `2>&1` on native commands sets `$?` false, `Set-Content` defaults to the ANSI code page. | Use `; if ($?) {}`; write files with `-Encoding utf8`; pass commit messages with `git commit -F <file>`. |
