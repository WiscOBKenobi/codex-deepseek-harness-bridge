# Question protocol verification

[English](question-verification.md) · [简体中文](question-verification.zh-CN.md)

Validated on macOS with Node 25.9.0:

- Full keyless regression: 124 passed, 2 skipped. Skips: upstream registry test expects a different fixed installation path; Windows-only helper requires Windows.
- Syntax checks: 42 JavaScript files passed.
- Real installed Harness smoke: successful turn became awaiting_answer; answer resumed the same session; JSON deliverable matched the expected content; one question round used. No Codex/OpenAI API request was added.
- Tests cover budget exhaustion/disablement, failed and invalid questions, idempotent answers, releasing the queue, waiting-task restart and cancellation, plus existing permission, process supervision and artifact review tests.

Offline Chrome browser acceptance passed, including question display, unbound/failed wake status, answer continuation, plain-text evidence rendering, and desktop/narrow layouts. It used a simulated runner and made no model requests. A queued test message started a new turn in the original Codex chat after the preceding turn ended, verifying idle-thread activation. The real bound Harness task then delivered its question event to the original chat; the answer resumed the same session. Its completion event independently activated another turn. RPC and disk reads confirmed the exact JSON artifact, one question round, and successful run 2; independent review was recorded as accepted. The delayed run-1 question event was ignored after the answer, without another execution. No repeated model polling or duplicate paid submissions occurred. The real smoke used local saved Harness authentication without reading credential contents. Local runtime records remain ignored by Git.
