/**
 * What every Odin feature does, in the user's terms: the raven's map of Odin,
 * served by `/odin` action=guide. He answers from this and the live state,
 * never from Odin's source. A feature you add or change belongs here too.
 */
export const ODIN_GUIDE = `# Odin

"Store:" names are for your own action=state calls. Never show them, or any other code, to the user.

## Left rail
Top to bottom: Dev Board, Tasks, Automations, Night Agent (status with its settings - the on/off switch, the window and the night's cap are edited right in the header - Last night - the sessions the last window started and where each stands now, click one to open it - the next run's picks - add, reorder, remove, and what to do after them - its log by night, and its instructions), More (the ⋮ button: Review, Insights, Session History). At the foot: Settings, and the raven button (Huginn, ⌘⇧I). Each but Night Agent has a one-key hotkey (rebind in Settings → Keyboard); the keys do nothing while you type, also inside agent terminals.

## Tasks screen and its feeds
Tabs, in two groups split by a hairline: Odin's own (All, Tasks, Docs), then the connections (Slack, Jira, GitHub, Notion, Email, ClickUp).
- **Badges** count only what waits on you: Slack counts only "Not started" rows, GitHub leaves out bot PRs, Email leaves out junk, Done rows never count. All is the sum of the others, minus your own PRs.
- **Amber dot** on a tab: that source is not connected. **Red dot**: connected but failing.
- Feeds reload every 2 minutes. **Sync** refreshes the connected sources.
- **Columns**: Task, Sweep, Priority, Status, From, Where, a date.
- **Row actions**: Open in <source>, due date, "Line it up - Up next" / "Take it off Up next", Tonight (moon, picks it for the Night Agent), "Mark it Read later - it moves to Docs", **Drop** (the ban icon, also in the side panel and on a Next in line card's hover: what Review's Drop does, no sweep needed - Done everywhere, listed under Review's Dropped, Undo on the toast), **Start** ("Session →" when a session already runs on it), **Done**.
- **Docs** lists saved docs (~/.odin/docs), sessions moved there off the board (Back to board resumes one, Forget drops the row), and Read later rows (Back to Tasks).
- **Done** is Odin only: nothing is written back to the source, and Undo is offered. A row done in one place leaves every feed. Store: done.
- **Same task, several feeds**: on All, a Jira ticket, the Notion page that copied it and the Slack message asking about it are one row when they share a Jira key or PR link, or the same title (four words or more). The owner's row stays (Jira, GitHub, ClickUp, Notion, Tasks, Slack, Email, in that order) with a chip per other source that opens it there; Done puts them all away. A reworded copy stays its own row.
- **Right-click a row** (any feed tab, or Review): "Drop <source> tasks like this from now on" - From <person>, In <repo/channel/project>, or Titled <exact title>. Matching rows are marked Done now and as they arrive. The rules list under All's Filter, "Dropped automatically"; × removes one and brings its rows back. Store: odin.all.dropRules.
- **Start** opens "Start: <title>": click Start session, or "+ Add context" for guidelines or images first. The session opens on the Dev Board.
- **Status** is Odin's own if you set one (Backlog, Prioritised, In progress, In review, On hold), else the source's. Odin's status stays in Odin.
- **Priority** maps to high, medium or low. A Slack reaction and a Jira @-mention always count as High.

## Tasks (your own backlog)
"my own list · start a session when you're ready". Type in "What needs doing?" and click Add task.
- The first line is the title, the rest is the brief.
- A leading "!" is Low, "!!!" is High, none is Medium. The Priority picker writes the same marks.
- A "/skill" after the "!"s (or the Skill picker) makes the session start by running that skill with the title as its argument.
- The Repo picker ("agent picks") sets the checkout. Empty: the agent picks the repo from the brief.
- Sorted by priority, then newest first. Starting a task keeps it on the list, linked to its session: started is not finished.
- Schedules (automations) don't show here. Each profile has its own list. The New task dialog has a Start now box.
- Store: tasks.

## Next in line (Dev Board column)
Tasks waiting to start, from Tasks, Slack, Jira, GitHub and Notion only (not Email or ClickUp). Anything with a live session, ever started, or Done drops out.
- "Newest first" until you click **Sort with AI**; then it reads "Sorted by AI · undo" with Re-sort. The sort words live in Settings → Backlog ("How to sort it"). Rows the AI hides come back with "show hidden (N)".
- Sections: **Tonight** (your picks, at most 20), then **Due** (dated tasks; overdue ones stay pinned up to 30 days by default, "Pin overdue tasks for"), then **Everything else**.
- Suspected duplicates are dimmed, and the Night Agent skips them.
- Store: nightAgent.

## Slack feed
- React to a Slack message with the **Queue** emoji (default :eyes:) to bring it in. The **Auto-start** emoji (default :robot_face:) brings it in and starts a session at once. Click either chip to change its emoji.
- Pills: Not started (no session ever), In progress (a session was started once), Done. It opens on the first pill with rows. Search matches the author only.
- Removing the reaction in Slack does not remove the row; Review's sweep can drop it.

## Jira feed
Open issues assigned to you, reported by you, or with a comment that @-mentions you. Pills: Assigned to me, Reported by me, Mentioning me, All (default; leaves out issues you only reported). Group by Sprints (default) or Projects (by epic, "No epic" last). Project filter and search. In Progress first, live sessions first, parked statuses (hold, blocked) last.

## GitHub feed
Open PRs. Pills: To review (default), Mine, Mentions. Bot PRs are hidden ("show bot PRs (N)"). Repo filter. Your own PRs don't count in All.

## Notion feed
Pick a database; turn on "@ Mentions" to add pages assigned to you and comment threads that @-mention you. Grouped by status, finished last. Odin sees only pages and databases shared with its integration.

## Email feed
Gmail inbox mail that was unread when Odin first saw it; it stays after you open it, until you mark it Done. Pills: Interesting (default) and All. Junk shows only under All; the model decides junk, and every calendar mail is junk. Read-only.

## ClickUp feed
Open ClickUp tasks assigned to you. Read-only, no filters.

## Review (rail, More menu)
"Sweep now" checks every backlog item (your tasks plus Slack, Jira, GitHub and Notion rows) against its source. It also sweeps on its own, every hour by default ("Sweep the backlog every" in Settings → Backlog; 0 turns it off).
- Verdicts: DROP, KEEP or UNKNOWN. DROP needs evidence: a merged or closed PR, a Jira ticket in a done status, the :eyes: removed in Slack, a thread someone else answered, or 21 days without activity. What it couldn't reach is UNKNOWN.
- Pills: Drop, Keep & unknown, Dropped. Keep and Drop per row, "Drop all N" for the rows on screen.
- Drop marks the row Done; on a task it also deletes the task, on a Slack row it marks the message done. Drop is off while a session still works on the row.
- Dropped lists what was dropped here and by hand from any row (evidence "You dropped this") - a by-hand Drop marks a task Done rather than deleting it, so Undo brings it back.
- Store: backlogReview.

## Dev Board columns
Four columns: **Working** (blue), **Needs you** (amber), **Final Review** (green, "just done"), **Idle** (grey).
- Needs you: sessions waiting on a prompt or question, failed sessions ("✗ failed - click to see what broke"), and live sessions whose status was cleared.
- Final Review: cards whose turn ended without asking anything.
- A dead session goes to Idle, except one the board closed for being idle: it keeps its column.
- PR state moves cards: while CI runs on a card's PR it shows in Working with "CI running". It moves from Needs you to Final Review when all that's left is merging approved PRs with no merge conflicts, a look, or its PRs were closed. It moves back to Needs you when the brief judges the latest reply asks you something.
- Sections in a column, in order: Starred, Recently finished (turn ended in the last 10 minutes while Odin was focused), Queued, Waiting on others, Parked, then Slack / Jira / GitHub / Notion / Normal.
- **Catch up** shows on Needs you and Final Review with more than 5 cards: one card at a time, "N Left", Next and ✓ Done.
- Drag a card to Idle to park it (a running turn gets Ctrl+C first). The session stays open.
- Undo is ⌘Z or the toast's Undo, for actions in the current board visit only.

## Board header
- **+ New Session**, **Search sessions** (title, brief, tags, person, repo, PRs), and a filter (Starred / Tags / Repos / People).
- **Next in line** toggle shows that column; ▶ Start launches a row, the moon picks it for tonight.
- **Reminders strip**: reminders whose day came and unread "New reply" pings, with Resume/Open, Snooze and ✕.

## Cards
- Hover: ☆ Star (pins to top), ✓ Done (always visible in Final Review), the bell Remind me (tomorrow at the earliest).
- Right-click: Star, Done, "Move to Idle", "Move to Docs" (off the board like Done, listed under Docs → Sessions, where the title reads the transcript and Back to board resumes it; Undo brings the card back), Remind me…, "Ping me" (pings on new replies when the session has a Slack or Jira thread, and when its PR gets approved; while nothing new came in, its Needs you or Done card waits in Idle under "Waiting on others", and a reply or approval brings it back to Needs you), "Turn on Remote Control" (when Settings is on "Selected sessions"), Keep (overrides a sweep's Drop), Tags (add your own).
- Pills: PR #N, "CI running", "Merge conflicts" (one of its open PRs conflicts with its base), "Just merge #N", "Review #N", "Dropped: PR merged/closed", "Duplicate? Same ask as…", Loop (a /loop session, with a countdown), a flame for a heavy session, Shell / Shell stopped / Shell exited, Automation, Night Agent, Auto-started.
- Idle cards have **Resume**, with "⏸ died mid-turn" or the exit cause. A session that died mid-turn is resumed on its own, once per run of the app. So is one whose Claude ended with a /loop still armed: it reopens at an idle prompt and the loop runs again. So is a remote-host session whose pane here died while its Claude still runs in tmux on the host: it reattaches without a click (one check per host for all its cards). One whose tmux ended there, whose host didn't answer, or that idle close closed keeps Resume.
- A remote-host session runs under its own memory cap on the host: half the host's RAM, no swap, through the host user's systemd, with nothing to set up. A runaway build in it hits that cap and its biggest process is killed, instead of freezing the other sessions there. A host where that isn't available runs the session uncapped.
- When the remote host runs out of memory (under 0.5 GB free, counting the host's cap on its users' memory), its sessions freeze: Claude stops drawing and typing seems to do nothing. The drawer of a session there then shows a red line saying so, with **Move to this computer**, which continues the conversation here.
- While sessions run on the remote host, the header shows its pill beside this Mac's: "<host> · N sessions · X GB free", yellow with "launches there wait" when the host is short of room, red with "out of memory · sessions frozen" when its sessions are frozen.
- **Done** ends the session: stops the process, removes the card and marks its feed row done. Its Undo resumes the same conversation.
- **Idle close**: a session idle longer than 3 hours (Settings → Sessions, "Close idle sessions after", 0 = never) is closed; Resume reopens it. Never closed: remote sessions (they hold nothing on this computer), working, queued, looping, waiting on CI, or a busy shell. Idle time counts from the later of the last status and the last Resume. Store: idleClose.
- **Idle compact**: a session whose card moves into Idle - parked there by drag or "Move to Idle", or put under "Waiting on others" by Ping me - gets /compact typed into it right away (Settings → Sessions, "Compact conversations moved to Idle", off by default), so its next reply starts from the summary while Claude's cache is still warm. Once per turn; never a looping or queued session, and one whose drawer is open waits until the drawer closes. Done and Needs you cards, and a session already in Idle when Odin starts, are left alone. The card shows Compacting in Working and comes back where it was. Store: idleCompact.
- Queued cards show "⏳ <reason>" and **Start now**, which ignores the gate. A card waiting on the remote host has no Start now: its **Start on this Mac** button (also under the wait in the drawer) starts it on this computer instead. Cards further back read "#N in line, after "X"". The queue starts the longest-waiting launch that can go. A Resume that opens at an idle prompt is never held.

## Sessions view and the session drawer
- The icon pair in the board header switches Board view and Sessions view (hotkey O). Sessions view opens the first session in flight, Needs you first; off when nothing is in flight. Its side list sorts by Needs you first / Last update / Waiting longest / Name, has Group, folds Idle away. ⌘⌥↑ / ⌘⌥↓ walk it.
- Drawer header: click the title to rename; source link and Remote Control pills; ★, ⑂ Diff, ❯ Shell, ⓘ Brief (open by default), ⛶ full width.
- Drawer footer: ↻ Resume / Continue / ▶ Start now, ■ Interrupt (Ctrl+C, terminal view only), Chat View, ✓ Done, Remind me, Minimize Session. Esc closes the drawer unless Claude's own menu is open.
- Continue types "Continue" into a live session (off while it works). Resume on a dead session reopens the same conversation at an idle prompt. If the transcript is gone: "That conversation is gone".
- **Diff**: the working tree, the branch's commits since it left main (no PR needed), or any PR the session opened. Comment on lines, then "➤ send N comments to agent".
- **Brief**: "PR #N has merge conflicts with main" at the top while one of its open PRs conflicts, Goal, Your action items (from the reply's ACTION ITEMS), Where it stands, links, token and cost figures, My notes (⌘Enter adds a note to your to-dos).

## Chat view and terminal view
Chat view is the default (Settings → Appearance, "Show sessions as a chat"; store sessionView). Switch with "Terminal View" in the composer or "Chat View" in the footer. Same session behind both; a question or plan approval still opens the terminal.
- Composer: Enter sends, Ctrl+Enter sends into a running turn, Shift+Enter new line, "!" bash mode, "/" skills, hold Space to talk.
- Claude's menus show as clickable cards.
- /btw questions never enter the transcript: the answer shows as a card with Close (sends Esc), and the composer hides while it is open.

## Shell pane
❯ Shell opens a terminal in the session's work folder (its PR worktree if it has one, else the checkout), the same shell each time. Dot: green = live in the session's work, amber = live elsewhere, red = disconnected. The ▾ menu moves the shell into any PR worktree or the checkout, shows which other shells sit there, and has VS Code (moves an idle conversation to VS Code). Agents run things you watch here (the /shell/run call).

## Worktrees
Odin doesn't make worktrees; agents do. The board reads where each session really worked, for the repo pill and the shell menu. "Delete worktrees when their PR merges" (Settings → Storage → Cleanup, on by default) prunes every 10 minutes in repos with a .worktrees folder: uncommitted files wait 7 days and are then saved to refs/pruned/<name>; a worktree with no commits touched in the last 24 hours is never removed. Settings → Storage lists each worktree (about 3 GB each), ticks the ones already on main, and deletes them. The remote host has no pruner: Done on a remote session removes its worktree there at once (the branch stays; uncommitted files are saved to refs/pruned/<name>), and Resume gets it back from the branch.

## New Session dialog
The first line is the title. Paste or drop images and video; "/" opens skills. "Repo: agent picks" takes a repo only when exactly one checkout matches what you typed, else the default folder. Model: Default / Fable / Opus / Sonnet / Haiku, kept for later launches. The Backlog toggle turns the button into "Add to backlog" and sends it to Tasks instead (no images). Store: claudeCommand (model, toBacklog).

## Notifications
A macOS banner "<task> needs you" ("Waiting for your reply" or "Finished its turn") with a sound when a session moves into Needs you. Not for parked sessions, or when it is on screen in the focused window. Clicking it opens the session.

## Session History (rail, More menu)
Search the transcripts of every finished session Odin launched, by word or by who asked (person chips). Resume reopens one in its folder on the board. Claude Code deletes transcripts after 30 days.

## All (Tasks → All)
One list across every source in bands: **Now** (due, or asked in the last 4 hours), **Today** (reviews and asks waiting on you), **Later**. A task you add here is Now for 4 hours, then Today; a Low one goes to Later. **Up next** sits on top; drag to reorder. A Live strip shows running sessions ("Go to session →"). Filters: Source, Priority, Place, Status, "Due or overdue only", "Show what's Done" (the graveyard: every row put away, done or dropped, newest first, each with Undo and Open; a row dropped by Review's sweep or a drop rule reads "dropped", with the reason on hover, and the toggle says "Done or Dropped" once there is one). Tick rows to Set status / Up next / Done together.

## Settings
The sidebar shows: Connections, Sessions, Remote, Storage, Backlog & Night Agent, Notifications, Appearance, Keyboard - one topic each, with what's on it written under its name. The search box above the list finds any setting by its label, its section or what it does, and scrolls to it. Store settingsScreen holds which one is open.

## Connections (Settings → Connections)
"The accounts Odin reads your work from." Sign-ins stay on this Mac. Each row has Connect, Reconnect and Disconnect; disconnecting takes that source's items out of every tab. Slack, Jira and Notion first ask for a Client ID and Secret when no OAuth app is set up. Huginn reaches every connected service's full API with action=service.
- **Profiles**: each profile has its own accounts, board sessions, Slack queue and tasks; only the active one shows anywhere. Rename in place, Switch to, or add one. A deleted profile can be restored for 30 days, then it is gone.
- **Claude**: "The account your sessions run on", for the whole Mac. Sign in / Reconnect opens the browser; paste the code if claude.ai shows one.
- **Slack** (read-only): the Slack feed. Set the Queue emoji (default eyes) and the Queue and start emoji (default robot_face).
- **GitHub**: your PRs and review requests, by device-code sign-in.
- **Jira** (read-only): your issues, in the Jira feed.
- **Notion**: a database's rows in the Notion feed. Odin sees only pages shared with it and their subpages; to add a teamspace, on its top page use ••• → Connections → Odin.
- **Gmail**: unread mail in the Email feed, by app password (needs 2-Step Verification), not OAuth.
- **ClickUp**: a personal API token (pk_…); sessions can read the ClickUp tasks they get.

## Sessions settings (Settings → Sessions)
A session's life on this Mac, top to bottom. Besides the launch gate limits ("When they start", below):
- **Where they start → Default folder**: where a session starts when no repo is picked. Unset: the folder your repos live in.
- **Where they start → Full Disk Access**: without it, macOS asks each time a session reads Music, Photos, Desktop or Documents.
- **What they run → Claude command**: what starts Claude, e.g. an alias for another account. One per line; with two or more, pick one in the top bar. Empty: claude. Store: claudeCommand.
- **What they run → Default prompt**: added to the end of every task prompt (how to work, the Shell, ACTION ITEMS), with Reset to default. The board reads ACTION ITEMS from each reply. Store: sessionInstructions.
- **On the board → Rename sessions automatically** (default on): renames each card once, after what it turned out to be about. Names you set are kept.
- **On the board → Compact conversations moved to Idle** (default off): /compact the moment a card is parked in Idle or waits there on others, while Claude's cache of it is still warm.
- **On the board → Read replies aloud** (default off): once a turn is over, Odin says the reply out loud in the open chat view - its TL;DR when the brief has one, else the reply itself. **Speech speed** sets how fast (0.5x to 2x). The speaker button under the latest reply reads it, or stops it, any time.
- **On the board → Close idle sessions after** (default 3 hours, 0 = never).

## Remote (Settings → Remote)
Your sessions when you're not at this Mac.
- **Remote host**: run new sessions on an EC2 instance of yours over AWS Systems Manager, so they keep going with the Mac shut. Pick the AWS profile, region and instance (Set up installs Claude, gh, tmux and git there; Use picks it), then the switch "Sessions start on <host>". Claude sign-in (the host gets its own), "API key at the plan limit", "Connectors on the host" (Slack, Notion, Jira, GitHub, ClickUp tokens kept on the host; Gmail never goes) and "Claude setup on the host" (copies parts of ~/.claude there; Sync again after you change them).
- **Remote host → GitHub accounts on the host**: one switch per connected GitHub account - whether its token goes to the host with a session (and as the GitHub connector there). A session gets the account that owns its repo when that one may go, else the main one. A task on a repo owned by an account kept off the host starts on this computer. Default: the main connection only.
- **Phone → Phone access**: the Odin iPhone app shows the board and answers sessions, on this Wi-Fi or through a relay, end to end encrypted. With it on, a QR code pairs a phone (once, for 10 minutes); paired phones are listed with Remove and Unpair all.
- **Claude app → Remote Control**: Off (default), Every session or Selected sessions. A session then shows in claude.ai/code and the Claude app as "[Odin] <task>". With Selected, turn it on per session from the card's right-click menu or the drawer.

## Storage (Settings → Storage)
- **Worktrees**: every session worktree (about 3 GB each), ticked when its work already landed on main; Delete removes the ticked ones. See Worktrees above.
- **Cleanup → Delete worktrees when their PR merges** (default on), see Worktrees.
- **Backup → iCloud Drive**: your board, briefs and scrollback, copied daily, kept 14 days in iCloud Drive → Odin Backups. Off until you click Back up now once; Disconnect turns it off again and keeps the saved days. To restore, quit Odin and copy a day's files back into ~/.odin.

## Notifications settings (Settings → Notifications)
Desktop banners (macOS controls them; the button opens System Settings), Sound on or off and Volume, and Reminders → Notify at: the time "Remind me" sessions and due dates notify on their day, one notification per day.

## Appearance (Settings → Appearance)
Theme: pick one, or follow the system with a Light theme and a Dark theme; custom theme files can be imported (256 KB at most). Text size (90% to 150%) makes Odin's own text bigger or smaller; the in-app browser keeps its size, while ⌘+/⌘- zoom everything. Sessions → Show sessions as a chat (default on), and Fold long replies (default on): a latest reply too long for the window folds under its TL;DR card; off shows the reply whole and the TL;DR card still shows. Links → Open links inside Odin: links from the listed sites open in a panel over the page; each site has a switch; other links go to your default browser. Stores: theme (fn setTheme), inAppBrowser.

## Keyboard (Settings → Keyboard)
Search and re-record any shortcut; a key already in use offers Reassign; Reset all. From any app → "Double-tap to show or hide Odin": Record, then tap a modifier twice.

## Top bar and updates
The top bar shows the machine load chip (session count, memory, CPU, free disk; click it when the disk is full to delete unused worktrees). Odin checks for a release every hour; a violet strip says "Odin X is available". Update and restart downloads it, quits and swaps in the new app; open terminal sessions survive the restart. Later hides it until the next check. Nothing installs on its own.

## Huginn (the raven)
The raven button at the bottom of the rail, or ⌘⇧I. Until first opened it has a pulsing violet ring. The panel shows sample asks and a "Got a job for me?" box (images can be pasted); earlier chats can be resumed (a click) or deleted (the ✕ on hover), and New chat starts a fresh one. He runs on Haiku with your Claude command, unless the model picker at the top right of his panel (Fable / Opus / Sonnet / Haiku) says otherwise - kept for later chats, and an open chat continues on the new model with its history (store: claudeCommand, key crowModel). Without Claude's task list or auto-memory, so a task goes to Odin's backlog and "always do X" becomes a rule. The conversation persists until ✓ Done. A turn silent too long counts as stuck and the next message resumes it in a fresh process. He is never a board card and takes no launch slot. A dot on the button means an answer, question or failure waits; it pulses while he works; his banner opens his panel.

## Automations (screen: Automations)
Three tabs: Schedules, Rules, Reminders.
- **Schedules**: tasks that start themselves on a schedule, only while Odin is open. Pick Repeat, day and time, or Custom for a cron. A run that came due while Odin was shut is skipped, not caught up. A due run starts even if the last run's session is still open; Pause stops it. "Run now" starts it at once. An optional tag makes it run only when an open session on the board has that tag; the run gets those sessions' paneIds and must drop the tag when done. Each run's card is tagged "automation". Schedules also show in My Tasks, marked amber with their schedule. Store: tasks (an automation is a task with a cron).
- **Rules**: "When <situation>, <action>" - standing instructions for every session Odin starts from now on. A session already running, or one you resume, keeps the prompt it had. A rule can be pinned to some repos ("in"), or to every repo except those ("not in"), and paused. Rules about pull requests or pushes are also re-sent to the agent each time it opens or pushes to a PR. Store: rules - fn add(when, action, repos?, exclude?), update(id, patch), remove(id).
- **Reminders**: every snoozed session and dated feed row, soonest first. "Remind me to ... on ... at ..." at the top adds a reminder of your own with no task behind it; it fires at its own time and has Done instead of Open. Resume early, Move the day, or drop one. A snoozed session shows on the board only when it is due. Store: reminders.

## Night Agent (Settings → Backlog & Night Agent, or the Night Agent page's header)
"Work the backlog overnight": inside the window (default 23:00 to 07:00) it starts the top task of Next in line, waits until that session stops working, then starts the next. One at a time, up to the night's cap (default 8 sessions).
- Rows you pick for tonight (up to 20) run first, in order. After them it stops, or goes on with the ranked queue (the "after picks" choice).
- Only Tasks, Slack, Jira, GitHub and Notion rows can run. Email and ClickUp rows can't.
- The AI ranks Next in line using your "How to sort it" words and the Night Agent instructions, so "don't include X" in either keeps X out. It re-ranks when the words change or new rows arrive.
- Its Instructions are added to every Night Agent session's prompt. The default says: work alone, open a PR, but send nothing other people see (no Slack, email, comments, merges or deploys).
- It runs only on power: on battery it starts nothing. Odin keeps the Mac from idle sleep during the window, but a closed lid still sleeps it. It runs only while Odin is open.
- On a remote host, a runner there (a timer, every minute) starts the night's sessions one at a time, so they run with the laptop closed. It holds the next one while the host has under a quarter of its memory free or its load is above its core count - the rule Odin itself applies before a launch to the host - and looks again a minute later. The hold is a line in the host's journal for the runner's unit (odin-night-<user>).
- Its log says when each window opened and closed, what it started, and why it started nothing (off, battery, Odin shut or asleep, cap reached, waiting on a session, everything ruled out, ranking failed). The Night Agent page groups it by night, newest first, and its Last night card lists the sessions the last window started with each one's state (Working, Needs you, Final Review, Idle, Done). Read the log with action=night.
- Store: nightAgent (offHours: enabled, start, end, maxSessions, instructions, picked, afterPicks; nightLog).

## One by one
Huginn can line up backlog tasks to run one after another: each starts when the last stops working. Odin drives the line. Store: oneByOne (ids left; set ids to [] to stop).

## Launch gate and Queued (Settings → Sessions → When they start)
A started session waits in Idle under "Queued", with a reason, until all limits allow it. Nothing is refused - the card exists from the start. Changes apply within 5 seconds.
- **Hold new sessions when this Mac is** over a CPU load (default 70%).
- **Hold new sessions when free memory is under** (default 2 GB).
- **Hold new sessions when free disk is under** (default 5%). Each session takes a worktree of about 3 GB. 0 means no limit.
- **Hold new sessions when this many are working** (default 5). Sessions waiting on you don't count. 0 means no limit.
- **One session per repo at a time** (default off): on, a session in a repo another one is working in waits until that one stops. Off lets them run side by side, each in its own worktree.
- Huginn takes no slot and holds no checkout.
- Store: launchLimits (hostCpuPercent, minFreeMemoryGb, minFreeDiskPercent, maxWorkingAgents, oneSessionPerCheckout; fn setLimits).

## Insights (screen: Insights)
What you got done and what it cost, week by week. Plain counts from session transcripts, no AI call. Panels: What you did, Shipped per week, Time with agents (your time vs agent time), Where the hours went (by repo, a repo can be hidden), Where work comes from (source), Who asks, Whose work you ran, Your queue, Improvements. Move between weeks with Previous week / Next week.
`;

/** The sections, each with its heading. */
const sections = () =>
	ODIN_GUIDE.split(/\n(?=## )/).filter((part) => part.startsWith("## "));

/** The whole guide, or only the sections that mention `q`. */
export function odinGuide(q?: string): string {
	const word = q?.trim().toLowerCase();
	if (!word) return ODIN_GUIDE;
	const hits = sections().filter((part) => part.toLowerCase().includes(word));
	return hits.length
		? hits.join("\n\n")
		: `No section mentions "${q}". Sections: ${sections()
				.map((part) => part.split("\n")[0].slice(3))
				.join(", ")}.`;
}
