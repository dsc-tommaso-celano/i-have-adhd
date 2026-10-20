---
name: walkthrough
description: 'Walk an ADHD reader through a plan, spec, architecture document, ADR, or design document one section at a time: what it says, why, what changes, what to decide. Use when the reader accepts a walkthrough offer or asks to be walked through a document.'
argument-hint: "[path to the document]"
license: MIT
metadata:
  tags: "ADHD, Accessibility, Plans, Specs, Architecture"
  category: "productivity"
---

# Walkthrough

The reader has ADHD and wants to understand a document before approving it or acting on it. This is an accessibility aid, not a summary: by the end, the reader knows what the document will do, why, and what they have to decide.

Document: $ARGUMENTS

If no document is given, use the most recent plan, spec, or design document in this conversation. If there is none, or more than one fits, ask for the path in one line.

The i-have-adhd rules apply throughout, even if they were never switched on in this session.

## Before the first message

1. Read the whole document.
2. If this conversation produced the document (for example, this is a forked side session), use that history to explain why each part exists. Mark anything you infer, rather than read in the document or the history, as your inference.
3. List every label the document uses: phase and step numbers, section numbers, requirement or ticket codes, acronyms, component and agent names.

## First message

1. One sentence: what the document is for.
2. The map: its sections in order, numbered, each with five to ten words of meaning. Group them if there are more than five. Add the reading time in minutes.
3. The glossary: each label from the list above, with its meaning.
4. Last line: "Start with section 1 (<its meaning>), or jump to another?"

## One section per message

Head each message `### <n> of <total>: <section title in plain words>`. Then:

1. **What it says.** Two to four sentences in plain words. Define any term you use.
2. **Why.** The problem this part solves, or the reason it was chosen over the alternatives. If neither the document nor the conversation says why, say so; do not invent a reason.
3. **What changes.** Concretely, for the reader, the code, the data, or the system: files, behaviors, commands.
4. **Decide.** Any decision, assumption, or risk the reader should check, as one question. Write "Nothing to decide here" when there is none.

End with: "Next: section <n+1> of <total> (<its meaning>). Questions first?"

Split a long section across messages rather than condensing it.

## During the walkthrough

1. Attach the meaning to every label every time: "phase 2 (moving auth into middleware)", never "phase 2" alone.
2. When the reader asks a question, answer it fully, then say where you are: "Back to section 3 of 6 (database migration)."
3. When the reader says they are lost, explain the same point again in smaller steps, with one concrete example from their code or data.
4. Do not edit the document or the code. Collect every change the reader asks for under "Changes to bring back".

## Ending

When every section is done, or the reader wants to stop:

1. What the document does and why, in three to five lines.
2. Decisions the reader made, and questions still open.
3. "Changes to bring back": a block the reader can paste into the main session as-is, written so it makes sense with no other context.
4. If this is a side session: "Paste the block into your main session. You can close this window." Otherwise, apply nothing until the reader confirms.
