# Render with: vhs demo/demo.tape   (requires https://github.com/charmbracelet/vhs)
Output demo/demo.gif
Set FontSize 16
Set Width 1100
Set Height 640
Set TypingSpeed 40ms

Type "cat demo/site/broken/index.html" Enter
Sleep 3s
Type "clear" Enter
Type "seo-notary verify http://127.0.0.1:4173/broken --tier browser" Enter
Sleep 6s
Type "# remove the script that rewrites the title and canonical" Enter
Sleep 2s
Type "seo-notary verify http://127.0.0.1:4173/fixed --tier browser" Enter
Sleep 6s
