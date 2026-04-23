# Inbox Agent

Inbox Agent is the local-first inbox workspace in CoWork OS. It keeps mail cached in the app, lets you review sent and received conversations side by side, and turns email into structured work instead of a long scroll of threads.

It is no longer just a mailbox viewer. The inbox now feeds a mailbox event pipeline that updates Knowledge Graph, Heartbeat v3, triggers, playbooks, Mission Control, and the daily briefing whenever sync, classification, summarization, draft generation, commitment extraction, handoff, or actions happen.

## What It Does

Inbox Agent helps you move from "read everything" to "act on the few items that matter":

- classify threads into `Unread`, `Action Needed`, `Suggested Actions`, and `Open Commitments`
- keep `Inbox`, `Sent`, and `All` views separate so outbound mail does not clutter the inbox
- show sent-mail content as thread content when you open a sent conversation
- sort by `Recent` or `Priority`
- multi-select threads for bulk archive, trash, mark-read, and cleanup flows
- generate thread summaries and draft replies before anything is sent
- extract commitments, edit commitment details, and track follow-up tasks
- resolve contact identities across email, Slack, Teams, WhatsApp, Signal, iMessage, and CRM-linked handles
- expose a unified relationship timeline and channel recommendation in the research rail
- reply directly via Slack, Teams, WhatsApp, Signal, or iMessage when the linked contact is more active there
- hand off a thread into Mission Control as a company issue and wake the recommended operator
- create inbox automations and reminders from the thread or current filter
- flag sensitive content so users can review outbound actions more carefully
- keep synced mail visible locally so a restart does not blank the inbox

## Why It Is Useful

The main advantage of Inbox Agent is speed without losing context:

- **Less manual triage** - important threads are surfaced directly instead of forcing you to scan the full mailbox
- **Fewer missed replies** - action-needed mail is separated from newsletters and system notifications
- **Clear next steps** - every thread can move toward a draft, a task, a commitment, or dismissal
- **Local-first persistence** - inbox state is stored in the local database and survives app restarts
- **Safer outbound mail** - generated drafts and sent-mail review stay visible before you confirm external actions
- **Better contact memory** - repeated conversations enrich contact intelligence and relationship context over time
- **Cross-system handoff** - inbox events can feed briefings, Heartbeat, triggers, playbooks, and the Knowledge Graph
- **Unified identity** - manual search/link in Settings can attach Slack, Teams, WhatsApp, Signal, iMessage, or CRM handles to the right person
- **Mission Control bridge** - important threads can become company issues with mailbox evidence and operator wake-up
- **Automation hooks** - inbox rules, scheduled patrols, and remind-later flows can create tasks, wake agents, and schedule reviews

## Core Surfaces

| Surface | What It Does |
|---------|--------------|
| Metric cards | Show unread mail, action-needed mail, suggested actions, and open commitments at a glance. |
| View filters | Switch between `Inbox`, `Sent`, and `All`. |
| Sort controls | Toggle between `Recent` and `Priority`. |
| Thread groups | Group threads by reply pressure, priority, or everything else when no narrow filter is active. |
| Thread list | Browse the mailbox with selection, bulk actions, and live filter/sort updates. |
| Thread detail | Inspect the full conversation, including received and sent message sections, summary, drafts, and commitments. |
| Agent rail | Run cleanup, follow-up, thread prep, todo extraction, scheduling, inbox automation, and intel refresh actions. |
| Reply rail | Send a reply through the contact’s active channel when Slack, Teams, WhatsApp, Signal, or iMessage is a better fit than email. |
| Mission Control handoff | Turn a thread into a company issue, choose an operator, and wake them with mailbox context. |
| Research rail | Review identity resolution, linked channels, recent subjects, unified relationship timeline, channel preference, and follow-up signals. |

## Typical Workflow

1. Open Inbox Agent and let it load the cached mailbox from the local database.
2. Review the metric cards to decide whether to focus on unread, action-needed, suggested actions, or commitments.
3. Switch between `Inbox`, `Sent`, and `All` if you want to isolate received mail from outbound mail.
4. Sort by `Recent` when you want the newest messages first, or `Priority` when you want the highest-signal threads first.
5. Open a thread and inspect the message body, summary, and related context.
6. Use `Prep thread` to generate a concise summary, extract commitments, and draft a response.
7. Switch to `Reply via` when the contact is more active on Slack, Teams, WhatsApp, Signal, or iMessage.
8. Turn important threads into Mission Control issues when they need a company-level operator handoff.
9. Send the draft, discard it, or turn commitments into follow-up tasks.
10. Edit commitment details inline when the due date, title, or owner needs correction.
11. Use `Refresh intel` when a thread changed and you want the summary, commitment extraction, identity links, and contact signals refreshed together.
12. Use bulk selection when you want to clear low-value mail faster.

## Actions In Practice

- **Cleanup** - suggests low-value mail that can be archived or handled in bulk
- **Follow-up** - surfaces stale threads that still need a response
- **Prep thread** - prepares the thread for action by summarizing it and drafting a reply
- **Extract todos** - finds commitments and turns them into trackable follow-up items
- **Schedule** - proposes or creates calendar time for the thread when a meeting is needed
- **Reply via channel** - sends the reply through the contact’s linked Slack, Teams, WhatsApp, Signal, or iMessage target when that channel is more active
- **Handoff** - creates a Mission Control issue, attaches the mailbox evidence, assigns the operator, and wakes them
- **Identity search and link** - manually search for handles or CRM records and attach them to the right contact identity
- **Refresh intel** - re-runs the thread analysis and contact intelligence for the selected conversation
- **Remind later** - snoozes a thread by creating a timed follow-up task
- **Automation rule / schedule** - create inbox-native rules or patrol schedules from a thread or filter
- **Auto-forward** - create a Gmail forwarding automation from the selected thread to route matching attachments to another mailbox
- **Bulk archive / trash / mark read** - clears multiple threads at once

## Gmail Forwarding Automations

Inbox Agent can create native Gmail forwarding automations from the selected thread with `Auto-forward…`.

What the flow does:

- creates a mailbox automation with sender/domain filters, optional subject keywords, attachment extension filters, and a target recipient
- stores the selected Gmail `providerThreadId` so thread-created automations stay scoped to that Gmail conversation instead of widening to the whole mailbox
- supports `dry-run` mode first so you can label and audit candidate messages before enabling real sends
- reconstructs and sends a new MIME email with the matched attachments instead of relying on Google Apps Script forwarding

Current behavior:

- **Gmail only** - the forwarding automation currently depends on Gmail API search, label mutation, attachment fetch, and send flows
- **Attachment-driven** - the built-in thread action currently defaults to PDF forwarding, but the underlying automation supports configurable attachment extension and filename keyword filters
- **Persistent scan watermark** - recurring runs track the last successful scan time and search with overlap, so a short app restart, laptop sleep, or delayed timer does not permanently drop matching mail
- **Per-message dedupe** - already-sent messages are tracked in the local database by automation id and Gmail message id, so later mail in the same thread can still be evaluated independently
- **Thread labels are status cues, not hard suppression** - candidate / rejected / forwarded Gmail labels are still applied for operator visibility, but they are not used as permanent search exclusions because later messages in the same thread may still qualify

Operational notes:

- `Run now` evaluates the automation immediately and then recomputes the next scheduled run from the current time
- a successful non-dry-run execution advances the stored scan watermark; dry-run keeps the watermark unchanged so you can repeatedly inspect the same candidate set
- thread-created automations keep the CoWork `threadId` for UI association and the Gmail `providerThreadId` for execution scoping
- Gmail modify scope is required because the automation creates labels, updates thread labels, fetches attachments, and sends mail

## Event Pipeline

Every meaningful mailbox action emits a normalized mailbox event. Those events can be consumed by other parts of the system without special-case wiring.

Mailbox events currently drive:

- Knowledge Graph enrichment for people, organizations, projects, and observations
- Heartbeat signal submission for stale threads, open loops, and cleanup candidates
- trigger evaluation for downstream actions
- playbook capture for repeated inbox patterns
- briefing summaries so the daily brief can show mailbox health
- unified identity and relationship timeline updates across email, Slack, Teams, WhatsApp, Signal, iMessage, and CRM-linked handles
- Mission Control handoff records so inbox-originated issues stay traceable

## Notes

- `Unread` remains provider-backed and deterministic.
- `Action Needed`, `Suggested Actions`, and `Open Commitments` are AI-assisted surfaces.
- Sent mail is shown as content when you select a sent thread, not hidden behind a separate abstraction.
- The reply picker prefers the most recently active linked channel and only offers real conversation targets.
- Identity search and linking stay conservative: exact matches auto-link, ambiguous matches require review.
- Mission Control handoffs remain inbox-owned at the source, even after operator assignment.
- Sending, archiving, trashing, marking read, and scheduling are still gated by the connected mailbox/calendar provider.
- Sensitive-content detection is surfaced as a warning and metadata cue, not a hard block.
- The inbox can re-sync in the background while still showing cached mail immediately.

For a higher-level overview of the product surface, see [Features](features.md). For copy-paste prompts that exercise inbox workflows, see [Use Cases](use-cases.md).

### Product plan (saved views, quick replies, snippets, MC links)

Implementation notes for the inbox roadmap (saved views / label-similar preview, quick-reply suggestions, snippets, triage feedback, Mission Control deep links, and weekly review schedules) live in [inbox-agent-product-plan-implementation.md](inbox-agent-product-plan-implementation.md).
