# Internal project index

Use the milestone file for scope, the human specifications for behavior, [STATUS](STATUS.md) for current handoff, and [DECISIONS](DECISIONS.md) for product context. Milestone IDs are internal to planning and GitHub work. Public roadmap data is maintained independently.

| Plan | Required predecessors | Review |
| --- | --- | --- |
| [M00 Marketing Website](milestones/M00.md) | None | Independent milestone review |
| [M01 Application Foundation](milestones/M01.md) | M00 | Milestone and security |
| [M02 Medical Expense Management](milestones/M02.md) | M01 | Milestone and financial |
| [M03 Payments and Payment Plans](milestones/M03.md) | M02 | Milestone and financial |
| [M04 HSA Reimbursements](milestones/M04.md) | M03 | Milestone and financial |
| [M05 Document Management](milestones/M05.md) | M02 | Milestone and security |
| [M06 Optional AI Assistance](milestones/M06.md) | M04, M05 | Milestone, financial and security |
| [M07 Self-Hosted Release](milestones/M07.md) | M06 | Milestone, financial and security |

M03 and M05 may run in parallel once M02 is accepted. Agree on attachment IDs, migration numbering and shared service contracts before dispatching both. Assign one writer per shared file or merge the relevant contract before branching. M04 can continue while M05 proceeds if their changes are isolated. Review threads can run in parallel on the same pushed commit.

Branches: `dev` is the default branch for all work and PRs; `main` is the release branch (image publishing and the public site deploy from it). See [coordination](COORDINATOR.md) and [cloud instructions](CLOUD-INSTRUCTIONS.md).
