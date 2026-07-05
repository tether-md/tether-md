# Why local-first note apps keep losing my trust

Every note app I have tried promises that my writing is mine. Then the sync
engine eats an edit, or the export arrives as a zip of JSON, and the promise
quietly dies.

The pattern is always the same. The app starts as a text editor and becomes a
database. My words stop being a file I can open anywhere and become rows the
app renders back at me. Export exists, but it is an afterthought — a lossy
snapshot instead of the document itself.

I think the fix is boring: keep the document as the source of truth, and make
every clever feature live inside it or leave no trace. Plain files survive
every platform shift. Databases survive until the next funding round.

So my test for a writing tool is now very simple: turn the feature off, and
show me the file. If the prose comes back exactly as I wrote it, byte for
byte, the tool respects me. If not, it never did.
