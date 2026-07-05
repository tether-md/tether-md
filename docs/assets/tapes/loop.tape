# The hero loop: comments live in the file -> byte-identical export -> preview -> accept.
# Regenerate from the repo root:  vhs docs/assets/tapes/loop.tape
# NOTE: keep Type strings ASCII-only (VHS mangles multibyte chars while typing).
Output docs/assets/loop.gif

Set Shell "bash"
Set FontSize 20
Set Width 1150
Set Height 620
Set Padding 24
Set WindowBar Colorful
Set WindowBarSize 36
Set BorderRadius 10
Set Margin 18
Set MarginFill "#171C26"
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms

Hide
Type `REPO=$PWD; T=$(mktemp -d); cp $REPO/examples/draft.md $T/original.md; cp $REPO/examples/reviewed.md $T/draft.md; cd $T`
Enter
Type `tether() { node $REPO/packages/cli/dist/cli.js "$@"; }`
Enter
Type `ID=$(tether comment list draft.md | python3 -c "import json,sys; print(next(c['id'] for c in json.load(sys.stdin) if c.get('proposal')))")`
Enter
Type "clear"
Enter
Show

Type "# this markdown file carries comments + an AI-proposed rewrite"
Enter
Sleep 1.6s
Type "tether status draft.md"
Enter
Sleep 3s
Type "# yet the document itself is untouched -- provably"
Enter
Sleep 1.2s
Type "tether export draft.md | diff - original.md && echo BYTE-IDENTICAL"
Enter
Sleep 2.6s
Type "# preview what Accept would change"
Enter
Sleep 1s
Type "tether comment diff draft.md $ID"
Enter
Sleep 3.6s
Type "# you decide -- the agent never applies"
Enter
Sleep 1.2s
Type "tether comment accept draft.md $ID --write"
Enter
Sleep 2s
Type "tether export draft.md | grep Databases"
Enter
Sleep 3.5s
