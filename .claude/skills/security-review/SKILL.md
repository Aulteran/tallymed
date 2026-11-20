---
name: security-review
description: Review TallyMed authorization, proxy, private files and local MCP.
argument-hint: "[PR or commit SHA]"
disable-model-invocation: true
---

Assigned input: $ARGUMENTS

1. Verify the revision and read docs/security.md and the milestone plan in Notion. Identify entry points, actors, network topology and trust boundaries.
2. Test authorization, session/CSRF, proxy header trust, access to direct objects, upload/download safety, rate and size limits, audit redaction and secret handling. Check backup access for touched recovery code.
3. For MCP, verify default disablement, listener isolation, network and credential enforcement, revocation, narrow tool scopes and browser approval of proposals. Test negative paths with synthetic data. Inspect workflow permissions if changed.
4. Report the reviewed SHA, blocking findings with reproduction, impacts, fixes to consider, and unverified areas. Leave merge and edits to their assigned owners.
5. Notion is the source of truth for status, decisions and milestone plans: the [TallyMed project](https://app.notion.com/p/41eab8277cf7812593a2cd3f3038a951) (use the Notion MCP with instructions_version 0.0.6 and confirm the workspace is AI Headquarters). After any repository change, update the Notion TallyMed project to record what changed (PR link, commit, outcome, next action).
