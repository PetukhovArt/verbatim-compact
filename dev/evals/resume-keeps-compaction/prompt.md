You coordinate one subagent. Follow these steps exactly and do not read the files yourself.

1. Call the Agent tool once, in the foreground, with subagent_type "general-purpose" and this prompt, verbatim:

<subagent-prompt>
Read fixtures/part-01.txt, part-02.txt and so on up to fixtures/part-08.txt from the working directory, one file at a time and in that order, each with one Read call of the whole file. After each Read write one line `CODE-nn=<word>` with the word from that file's first line, and nothing else about the file. After part-08, reply `done`.
</subagent-prompt>

2. When the Agent call has returned, call SendMessage to that same agent (its agent id is in the Agent result) with this message, verbatim:

<follow-up>
Without calling any tool, answer only from what is in your context right now. For each file nn from 01 to 08 write two lines: `CODE-nn=<word>` with the word on that file's first line, and `TAIL-nn=<word>` with the word on its line starting `TAIL-nn:` near the end of the file, or `TAIL-nn=NONE` when that line is not in your context because the Read result you have was cut.
</follow-up>

3. Wait for the agent's reply to that message. Your final message is that reply, copied verbatim.
