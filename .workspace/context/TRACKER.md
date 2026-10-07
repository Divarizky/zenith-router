# Feature execution progress. See `.workspace/context/SRS.md` for requirement lifecycle.
# Review 07-10-2026 reopened F-01..F-03: their tasks are done but some approved requirements are not met yet
# (see "Known Gaps" in SRS.md).
tracker: local
features:
  - id: F-01
    status: open
    source: to-requirements
    created: 2026-10-06
    updated: 2026-10-07
    task_count: 4
    task_done: 4
    # gaps: tool calling, /v1/messages translation, /v1/responses
  - id: F-02
    status: open
    source: to-requirements
    created: 2026-10-06
    updated: 2026-10-07
    task_count: 4
    task_done: 4
    # gaps: OAuth login/refresh endpoints, background refresh loop, failover (GR-03), registry vs 9router
  - id: F-03
    status: open
    source: to-requirements
    created: 2026-10-06
    updated: 2026-10-07
    task_count: 3
    task_done: 3
    # gaps: streaming usage records 0 tokens, live quota fetcher is a stub
  - id: F-04
    status: closed
    source: to-requirements
    created: 2026-10-06
    updated: 2026-10-07
    task_count: 3
    task_done: 3
  - id: F-05
    status: closed
    source: to-requirements
    created: 2026-10-06
    updated: 2026-10-07
    task_count: 3
    task_done: 3
  - id: F-06
    status: closed
    source: user-instruction
    created: 2026-10-07
    updated: 2026-10-07
    task_count: 6
    task_done: 6
