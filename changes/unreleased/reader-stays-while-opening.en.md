- **The reader no longer jumps when a material takes a moment to open.** While a material was being read, 正在打开资料… took a line above the quote and the text. The 目录 button and each page's 看原页 were missing, and in a wide window the 目录 column was not there yet. When the material came:
  - that line went away, so the quote and the text moved up about 60 px;
  - the toolbar grew a few pixels;
  - every page grew a line for its 看原页;
  - in a wide window the text slid 272 px to the right.

  On a fast machine this happened within half a second of the click and was hard to see. On a slow one it was a visible jump. Now 正在打开资料… floats over the top of the text instead of taking a line. 目录 and each 看原页 keep their place, hidden until they can be pressed. In a wide window the 目录 column keeps its width. Nothing already on screen moves when the material comes.
  - Not verified: measured in the preview page (Chromium) at 1280 and 420 px, with the material's answer held back as on a slow machine. Not looked at inside DSH, in the desktop app or in WebKit. Some things still move when the material comes:
    - A material with no 目录 at all, opened in a wide window, gives its reserved column back.
    - The 错题 and 思维导图 buttons still appear in the toolbar, which moves the place line beside them.
    - The 看原页 inside a figure line and the one beside the quote still appear only then.
