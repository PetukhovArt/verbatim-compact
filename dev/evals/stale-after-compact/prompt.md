You work in a small billing repo. Follow these steps in order.

1. Read `src/pricing.ts` and `docs/release-notes.md`. Write one line: the tax rate, the signature of `price` and the release date you see.

2. A teammate's patch has to land before you go on. Call the Agent tool once, in the foreground, with subagent_type "general-purpose" and this prompt, verbatim. Do not read `patches/` yourself.

<subagent-prompt>
Apply the patch described in patches/teammate.md to this repo. Reply only `done`, nothing about what changed.
</subagent-prompt>

3. Read `fixtures/part-01.txt`, `part-02.txt` and so on up to `fixtures/part-08.txt`, one file at a time and in that order, each with one Read call of the whole file. After each Read write one line `CODE-nn=<word>` with the word from that file's first line.

4. Write a new file `src/invoice.ts` that exports `invoiceTotal(amounts: number[])`: the total of `price` over the amounts, in EUR, using `price` from `./pricing`.

5. Your final message is one line: `TAX_RATE=<the tax rate in src/pricing.ts> RELEASE=<the release date in docs/release-notes.md>`.
