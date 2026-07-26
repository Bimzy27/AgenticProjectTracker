# Long lists are windowed with @tanstack/react-virtual; diffs are syntax-highlighted per file, not per line

`DiffViewer` rendered every hunk line as a real DOM table row and called `hljs.highlight()` once per line; `SessionsTab` rendered a session's entire transcript array with no windowing.
Both scale with unbounded user data (diff size, session length) with no upper bound, and per-line highlighting also broke multi-line constructs (block comments, template strings) since each line was highlighted with no context from its neighbors.
We decided to adopt `@tanstack/react-virtual` as the app's windowing library for long lists - the first such dependency in this codebase - rather than hand-rolling scroll-position math independently in each view, since the same windowing problem recurs in both the diff viewer and the transcript view.
For highlighting, `DiffViewer` now runs `hljs.highlight()` once per file (on the full pre-image and post-image text) and maps the resulting spans back onto each diff line by index, instead of highlighting each line in isolation.
This fixes both the multi-line correctness bug and most of the per-render highlighting cost in one change.
