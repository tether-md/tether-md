# Why local-first note apps keep losing my trust

Every note app I have tried promises that my writing is mine. Then the sync
engine eats an edit, or the export arrives as a zip of JSON, and the promise
<!--tether:c=01KWQ2QFB77XCX80856XVHZWY4-->quietly dies.

The pattern is always the same. The app starts as a text editor and becomes a
database. My words stop being a file I can open anywhere and become rows the
app renders back at me. Export exists, but it is an afterthought — a lossy
snapshot instead of the document itself.

I think the fix is boring: keep the document as the source of truth, and make
every clever feature live inside it or leave no trace. Plain files survive
every platform shift. <!--tether:c=01KWQ2QFDFTHXWAF7RJS1ZNSSX-->Databases survive until the next funding round.

So my test for a writing tool is now very simple: turn the feature off, and
show me the file. If the prose comes back exactly as I wrote it, byte for
byte, <!--tether:c=01KWQ2QFK0E9684VBGWE1SHDF7-->the tool respects me. If not, it never did.

<!--tether:store
{"id":"01KWQ2QFB77XCX80856XVHZWY4","v":1,"trust":"fact","author":"human","body":"too melodramatic — tone it down","status":"open","created":"2026\D07\D04T17:27:26.311Z","target":{"quote":{"exact":"quietly dies","prefix":" a zip of JSON, and the promise\\n","suffix":".\\n\\nThe pattern is always the sam"},"position":{"start":203,"end":215}},"kind":"comment"}
{"id":"01KWQ2QFDFTHXWAF7RJS1ZNSSX","v":1,"trust":"fact","author":"human","body":"sharpen this — best line in the piece, but 'funding round' is a cliché","status":"open","created":"2026\D07\D04T17:27:26.383Z","target":{"quote":{"exact":"Databases survive until the next funding round.","prefix":"s survive\\nevery platform shift. ","suffix":"\\n\\nSo my test for a writing tool "},"position":{"start":665,"end":712}},"kind":"comment","proposal":"Databases survive only as long as the company that rents them to you."}
{"id":"01KWQ2QFK0E9684VBGWE1SHDF7","v":1,"trust":"interpretation","author":"agent","body":"Flag\Dback: 'respects me' does a lot of work here — is the claim about data ownership or about UX? Happy to propose either reading.","status":"open","created":"2026\D07\D04T17:27:26.560Z","target":{"quote":{"exact":"the tool respects me","prefix":"y as I wrote it, byte for\\nbyte, ","suffix":". If not, it never did.\\n"},"position":{"start":870,"end":890}},"kind":"comment"}
tether:store-->