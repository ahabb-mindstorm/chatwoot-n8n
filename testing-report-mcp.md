# MCP-derived live test report — runs 1113–1182

**Date:** 2026-06-04  
**Workflow:** `pi1FV25pGTEu4rwm`  
**Expected matrix:** `testing.md`  
**Source of truth:** n8n MCP execution data for runs **1113–1182**. The prior written report was used only to identify this run range.

---

## Executive summary

The run range contains far less scenario coverage than the earlier report implies. Out of 70 executions, only **10** produced bot-handled customer outcomes. The other **60** were webhook noise/skips:

| Outcome | Count |
|---------|------:|
| `skip: unsupported_event` | 47 |
| `skip: not_customer_incoming` | 13 |
| Guided replies | 4 |
| RAG public replies | 3 |
| Handoffs | 3 |

From a customer perspective, the bot was helpful on basic entry, missing-reward form entry, FAQ answers, explicit menu reset, and human handoff. The main quality issues are **inconsistent withdrawal answering**, **poor handoff copy**, and **lack of clear next-step controls after FAQ answers inside an active guided flow**.

No valid handled execution in this range shows `capital of France`, refund, inappropriate ad, attachments, purchase, gameplay, or guided completion RAG. Those scenarios should be treated as **not covered**, not pass/fail.

---

## Actual handled timeline

| Run | Customer input | Bot outcome | Customer-quality assessment |
|-----|----------------|-------------|-----------------------------|
| 1116 | `hi` | Main menu input select | Good. Clear start point. |
| 1122 | Click `Missing Reward` | Missing reward form | Functional, but copy is generic: “Please provide the required information below.” |
| 1126 | `hello` while in form | Re-rendered missing reward form | Acceptable per active-flow greeting rule; slightly robotic because it does not acknowledge the greeting. |
| 1132 | `what are coins for?` while in missing reward flow | RAG FAQ answer, `rag_answerable: true` | Helpful answer. Break-out from form worked. Missing next-step controls to continue report or return to menu. |
| 1141 | `how long does withdrawal take?` | RAG FAQ answer, `rag_answerable: true` | Helpful and specific. Same missing next-step issue. |
| 1147 | `how to withdraw?` | RAG FAQ answer, `rag_answerable: true` | Best withdrawal response in range. Specific step-by-step answer. |
| 1153 | `menu` | Main menu reset | Good. Explicit reset worked from the active guided/LLM state. |
| 1159 | Click `Talk to a human` | Handoff | Functionally correct, but public copy is poor for explicit human request. |
| 1165 | `how to withdraw?` at main menu | Public withdrawal answer, but evaluator sent handoff because `knowledge_used` was empty | Customer sees an answer, but it is weaker/generic and operationally escalates. This is inconsistent with run 1147. |
| 1174 | `talk to a human` | Handoff | Functionally correct, same poor handoff copy. |

---

## Scenario evaluation against `testing.md`

### Covered and passing

| Scenario | Evidence | Evaluation |
|----------|----------|------------|
| Fresh greeting shows menu | 1116 | Pass |
| Guided menu option opens form | 1122 | Pass |
| Active-flow greeting re-prompts current node | 1126 | Pass |
| FAQ break-out while inside form | 1132, 1141, 1147 | Pass |
| Explicit `menu` reset | 1153 | Pass |
| Human handoff by click/text | 1159, 1174 | Pass functionally, UX copy needs work |

### Covered but degraded

| Scenario | Evidence | Issue |
|----------|----------|-------|
| FAQ answer quality/consistency for withdrawal | 1147 vs 1165 | Same user intent produced different quality and different backend action. 1147 was clean RAG; 1165 escalated despite showing an answer. |
| Customer recovery after FAQ inside active flow | 1132, 1141, 1147 | Bot answers but leaves state in guided/LLM context without visible “Continue report / Main menu / Human” options. |
| Human handoff | 1159, 1174 | Copy says “outside what I can confidently help with,” which is odd when the user simply asked for a human. |

### Not covered in this run range

These planned scenarios do not have a handled customer execution in `1113–1182`:

- Out-of-scope question such as `what is the capital of France?`
- Refund, credentials, legal, data deletion guardrails
- RAG to `missing_reward_form` from natural issue text
- Guided form submission to attachment prompt
- Attachment upload handling
- `Nothing to attach`
- Guided completion RAG
- Inappropriate ad / ad sub-option routing
- Purchase flow
- Gameplay question flow
- Clarification menu
- Edge cases H1–H7
- Random exploratory suite

Because these are absent from the MCP data, they should not be reported as pass or fail for this run range.

---

## Customer-experience findings

### 1. FAQ answers are sometimes good, sometimes inconsistent

The bot gave strong FAQ answers for coins, withdrawal timing, and one withdrawal-steps query. These were useful and likely satisfy a customer.

However, `how to withdraw?` appeared twice with materially different behavior:

- Run 1147: specific step-by-step answer, clean FAQ path.
- Run 1165: generic answer and backend handoff because `knowledge_used` was empty.

Customer-facing harm: the user may get a less trustworthy answer in one context than another. Operational harm: support may receive escalations for questions the bot already answered.

### 2. Handoff copy is not good enough

For both explicit human routes, the bot replied:

> Thanks for reaching out. This looks outside what I can confidently help with as ProGolf support...

That wording is inappropriate for “Talk to a human.” The user did not ask an out-of-scope question; they asked for a person. Better copy:

> Sure, I’ll connect you with our support team. Someone will follow up here as soon as possible.

### 3. The form prompt is functional but low-empathy

The missing reward form prompt is just:

> Please provide the required information below.

It works, but it does not reassure the customer or explain why the fields matter. Better:

> Sorry about that. Please share a few details so we can look into the missing reward.

### 4. FAQ break-out works, but the bot does not guide the user back

Runs 1132, 1141, and 1147 show the bot can answer FAQs while inside a guided form. That is good.

But after answering, it leaves the customer without obvious choices. A user who was midway through reporting a missing reward may wonder: “Do I keep filling the form? Did we leave the report?” Add a small follow-up menu after FAQ-in-guided-context:

- Continue my report
- Ask another question
- Main menu
- Talk to a human

### 5. Skip executions should not be counted as customer failures

The majority of executions are outgoing updates, system events, or non-customer messages. They are expected webhook noise. They should not be counted as user-intent failures unless there is a matching customer message with no handled execution.

---

## Revised pass/fail for this run range

| Category | Count | Notes |
|----------|------:|-------|
| Customer-intent handled runs | 10 | Only these should be scenario-evaluated. |
| Clear pass | 6 | 1116, 1122, 1126, 1132, 1141, 1147 |
| Functional but UX-degraded | 3 | 1159, 1165, 1174 |
| Clear fail | 0 | No handled execution clearly violates `testing.md` expectations. |
| Not covered | Many | Attachments, ads, purchase, clarification, out-of-scope, most guardrails, random tests. |

This means the bot performed better than the prior report suggests for the scenarios that actually ran, but the coverage is too narrow to claim broad quality.

---

## Recommended next test pass

Use fresh conversations per suite and verify each customer message produced a handled execution before moving on.

Priority scenarios:

1. Out-of-scope: `what is the capital of France?`
2. Attachment upload at `attachment_prompt`
3. `Nothing to attach` guided completion RAG
4. Natural ad issue: `I got an inappropriate ad`
5. Purchase completed but missing items
6. Guardrails: refund, credentials, legal, data deletion
7. Clarification: `withdrawal problem`
8. Random exploratory prompts from Suite I

For every FAQ case, record both:

- Widget reply text
- `Evaluate RAG Answer` output: `route`, `action`, `rag_answerable`, `knowledge_used`, `confidence`

This will separate “customer got a useful answer” from “workflow state/action is correct.”
