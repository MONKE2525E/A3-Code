# Pull requests on mobile

Open **Pull requests** from Home or the sidebar to browse repositories in a
connected environment. Tap the search icon in the top bar to search by title,
`#number` or author. The filter icon opens the options:

- **Sort** orders the pull requests already loaded: recently or least recently
  updated, newest or oldest.
- **Filters** opens a sheet for state (open, merged, closed, all), involvement
  (everyone, review requested, authored by you), project and sort. The filter
  icon fills when the options differ from the defaults, and **Reset** clears them.
- Environment selection appears in the filter sheet when more than one environment is connected.
- The refresh button in the top bar asks the host for fresh results. Pull down on the list
  does the same.

Filters and sorting are remembered on this device when you leave the page or
restart the app. **Reset** restores the defaults. Switching environments clears
the project filter.

Each row shows the state, title, repository, number, author, branch and how
recently it changed. A list that cannot load shows the reason with a **Retry**
button. If some rows loaded and a project or host did not, or a refresh failed, a
single notice above the list names what is missing and the rows stay on screen.
An environment without pull request support, or without projects, says so instead
of showing an empty list. **Load more** appears when more results are
available.

Select a pull request to read its **Summary** (description, checks, reviewers,
labels, merge status), follow comments and commits in **Timeline**, or inspect
changed files in **Code**. On a phone the pull request replaces the list and Back
returns to it. An unfolded foldable shows the pull request at full width, with the
merge box beside the header and the Summary in two columns. On a tablet or another
very wide screen the list stays beside the selected pull request. The open tab and
any draft comment carry across folding and unfolding. Tap a long title to show all
of it; the header shrinks to one line while you scroll. Collapse **Description** or
**Checks** to make room while reading. Markdown task lists show completed and
incomplete checkboxes. If the environment is slow to answer, the screen says so
after a few seconds and offers **Retry** and **Open on GitHub**.

The merge box under the header shows whether the pull request is ready, blocked
by checks or conflicts, or already merged. Its button does the next step: merge
with the chosen strategy, mark ready for review, enable auto-merge while checks
run, or resolve conflicts in a thread. The arrow beside it picks the merge
strategy and offers **Merge now**, **Disable auto-merge** and **Update branch**
where they apply. On GitHub, **Merge as admin** merges past branch protection by
running `gh pr merge --admin` on the connected environment as you. It needs the
GitHub CLI and admin rights on the repository, and a session allowed to use
terminals.

The Code tab loads large changes a slice at a time; **Next files** continues and
**First files** returns to the beginning. Collapse file headers or mark files as
viewed while reviewing the current pull request.

The Timeline tab offers comments and supported review verdicts when your account
has permission. Submission asks for confirmation. If it fails, your draft stays
in the editor. The three-dot menu includes refresh, copy link or number, and
supported draft and close actions. Actions depend on the host and your
permissions; merging and closing ask for confirmation. **Open on host** remains
available for content that the connected provider cannot supply.

A pull request link in a chat message, a linked pull request or a pull request
context chip opens here when its repository belongs to one of the thread's
environment's projects. It opens that pull request alone, even on wide screens,
and Back returns to the thread. From there the menu can link or unlink it, and
**Ask a question**, **Explain this PR** and **Fix findings in this thread** fill
that thread's composer and take you back to it. Nothing is sent until you send
it, and text you already wrote stays. Opened from the list, the same actions
start a new thread on the project instead; fixing findings first checks the pull
request out into its own worktree. Other links, and pull requests from
repositories the environment does not hold, open in the browser or host app as
usual.

Repository access and authentication use the connected environment's source
control tools. A missing tool, an expired login or a host rate limit appears in
the list so you can repair it on the environment. Pull request viewing also
works over remote connections.
