# AgentTeam capture notes

Captured October 25, 2026 from AgentTeam 0.4.0 on Windows, checkout b7271d5.
The Notes app team, messages, tasks, and source files are fictional fixtures
in a separate data profile. Execution stayed paused; the conversation is not
a live provider run.

- The renderer and Electron main process rebuilt successfully, with the existing large-chunk advisory.
- The latest five PNGs are 1700 × 1180, captured against a separate profile (AGENTTEAM_TEST=1, AGENTTEAM_ENABLE_LIVE=0). They replace the earlier selection; Project tasks is omitted, and Chat includes a shared conversation plus the Python Builder's perspective.
- The Layout capture has assigned Python/testing/review skills and distinct folder access: the Builder can edit source and tests, while the Reviewer can read them. The shared chat contains five sample messages among three agents and the user.
- The Python diff is unified. Capture assertions verified keyword, comment, and string tokens; a keyword rendered as rgb(92, 30, 112). The editor and diff both show notes.py. All five captures completed without renderer page errors.
- A folder baseline compared the sample search change in notes.ts; no project Git commits or production data were involved.
- Images were visually inspected, with no renderer page errors. This was screenshot verification, not a complete application test suite.
- **Existing UI detail for Claude:** The Projects panel's context banner says “None selected” while the top project picker and selected project say “Project Notes.” The capture preserves that actual app behavior.

The combined review page is C:/CLAUDIO/ui-ux-screenshot-preview.html.

Keep these capture records out of README captions and the screenshot preview.
