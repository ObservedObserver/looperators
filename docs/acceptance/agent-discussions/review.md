# Independent review and regression checks

The implementation was reviewed by a separate Codex agent. The reviewer inspected runtime scheduling, versioned completion, identity and publication boundaries, persistence, Council follow-ups, and UI navigation. The implementer applied the fixes; the reviewer then checked the affected paths again.

| Finding | Resolution |
| --- | --- |
| Reading newer evidence after an old assessment could clear pending work without reassessing. | Pending assessment work now follows the assessment revision, with a regression for that exact ordering. |
| A Room mention queued during an ordinary private-chat turn did not resume after that turn finished. | Ordinary member settlement also drains queued attention. |
| Open graph from a workspace Council closed the overlay but left the workspace visible. | It now selects Chat and expands the graph. |
| Returning to a workspace could repopulate a previously consumed recommendation draft. | Draft transfer is acknowledged once and preserved in local editor state. |
| A follow-up turn could publish new evidence without assessing it, leaving its author stale with no next turn. | Publications queue all required participants, including the author. A current assessment cancels the author's redundant pending turn during settlement. |
| A linked goal could finish while another Agent was still replying in its source Thread. | Related pending and running Thread turns block completion; their settlement rechecks the goal. Failed related turns remain visible and require recovery. |
| A member's failure in another Thread could be mistaken for an error in any Thread it had ever visited. | Attention records its originating trigger. Completion and retry use that exact origin, including goal turns that intentionally have no Room thread id. |
| Opening a private chat would unmount the group chat and lose the selected Thread and draft. | The selected group chat remains mounted while hidden during private-chat navigation. |
| Mixed-provider UI turns repeatedly published agreement, invalidating otherwise current assessments. | Initial and per-turn instructions now distinguish ordinary replies from goal turns. Goal turns publish only new findings; agreement uses the visible assessment tool and every wakeup requires a current assessment. |
| Compare plans showed a successful preview even when existing sessions would exceed its workflow capacity. | Preview now uses the shared workflow compiler and validator, shows actual capacity, and disables Run on errors. The authoring helper also stops an invalid server proposal before approval; runtime commit validation remains authoritative. |

The reviewer also checked the subsequent synchronous startup recovery fix, early validation of Council stage notes, focused collaboration tool inventory, and bounded inline Council evidence. A final review caught a versioned topic mismatch in specialist delivery metadata; the topics now match the inline evidence markers, with an integration check against the actual specialist activation. No unresolved actionable finding remained from those reviews.

Regression evidence:

- Final production build, lint, and all 192 CI unit tests passed. Existing lint warnings and the bundle-size warning remain.
- The final complete kernel node run on the revised Thread implementation passed all 674 tests with zero failures.
- After the shared activation metadata fix and before the Thread revision, a complete kernel node run passed all 663 tests with zero failures.
- The initial complete kernel run found a Council crash-recovery regression caused by an asynchronous startup recovery command. The isolated reproducer passed after moving necessary recovery into the synchronous startup transaction.
- The next complete node run passed 656 of 657 cases, including Council crash recovery. The remaining existing Grok catalog test failed on a one-millisecond difference between separately stamped response timestamps. It now validates both timestamps while comparing model contents and retaining the single-probe assertion; its focused rerun passed.
- All four kernel smoke scripts passed: graph orchestration, persistence/recovery, membrane validation, and Codex approval/user-input plumbing.
- After the real-provider fixes, 28 focused collaboration/MCP/Claude/settings tests and 55 Council/context/workflow-governance tests passed. The final specialist delivery-topic fix passed both the specialist integration and Council crash-recovery checks.
- The revised Thread implementation passed all 24 collaboration kernel tests, including attention-source and retry-scope regressions. A later concurrent suite exposed a stop-test timing assumption: provider close removes its run before the terminal state projection settles. The test now waits for settlement and checks that artifacts do not grow after stop, instead of assuming no proposal could have finished before stop.
- After the goal prompt correction, the runtime build and 24 collaboration regressions passed again. A real mixed Claude/Codex scenario then completed five turns with ordinary user instructions, current assessments, no repeated public acknowledgements, and no manual retry.
- Four added preview regressions passed in the implementer's and independent reviewer's runs. They cover default capacity, archived sessions in other project folders, persisted limits and the exact allowed boundary, no preview mutation, and approval/commit ordering. The reviewer confirmed that the capacity and scope were not expanded.

These regression checks use controlled providers where appropriate. Product acceptance uses real providers and is documented separately in [the headless report](./headless-acceptance.md) and [the UI evidence report](./ui-acceptance.md).

The final UI run also observed Claude writing a provider-owned plan file through Bash without a looperators permission request. Independent review confirmed the installed provider's native plan-file exception. The project fixture remained unchanged. The guide and UI report explicitly distinguish project read-only operation from an operating-system sandbox; no host-wide zero-write guarantee is claimed.
