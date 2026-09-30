// Pure data shaping for the TickTick widget. No QML types in here on
// purpose: everything below is plain JS so it can be exercised by node in
// tests/ without a running shell (see tests/model.test.js).

var STATUS_TODO = 0
var STATUS_WONT_DO = -1
var STATUS_DONE = 2

var CHECKIN_DONE = 2

// ---- dates -------------------------------------------------------------

// TickTick serializes with a numeric offset ("+0000"), which Date.parse
// only handles by accident. Normalizing to "+00:00" makes it an ISO string
// every engine agrees on.
function parseApiDate(value) {
  if (!value) return null
  var text = String(value).trim()
  if (text === "") return null
  if (text.length >= 5 && (text.charAt(text.length - 5) === "+" || text.charAt(text.length - 5) === "-")
      && text.charAt(text.length - 3) !== ":") {
    text = text.slice(0, -2) + ":" + text.slice(-2)
  }
  var parsed = new Date(text)
  return isNaN(parsed.getTime()) ? null : parsed
}

// An all-day task is a calendar date wearing a timestamp. Converting it
// through the local zone is how "due today" becomes "due yesterday" for
// anyone west of UTC, so the date part is read literally instead.
function taskDueDate(task) {
  if (!task || !task.dueDate) return null
  if (task.isAllDay) {
    var head = String(task.dueDate).slice(0, 10).split("-")
    if (head.length === 3) {
      var day = new Date(Number(head[0]), Number(head[1]) - 1, Number(head[2]))
      return isNaN(day.getTime()) ? null : day
    }
  }
  return parseApiDate(task.dueDate)
}

// A task with a duration keeps its start in `startDate`, while `dueDate`
// becomes the end of the block — which is why "Meeting 8:30–9:30" read as
// 9:30 everywhere. An ordinary timed task carries the same instant in both
// fields, so only a start that really moves earlier counts as a span.
function taskStartDate(task) {
  if (!task || task.isAllDay) return null
  if (!task.startDate || !task.dueDate) return null
  var start = parseApiDate(task.startDate)
  var due = taskDueDate(task)
  if (!start || !due) return null
  if (start.getTime() >= due.getTime()) return null
  return start
}

// The instant a task "happens": the start of a duration, otherwise the due
// time. Sorting and the horizon cutoff share it, so a meeting is placed by
// when it begins and one starting late tonight is not pushed out of the
// Today view by its after-midnight end.
function taskTimeKey(task) {
  return taskStartDate(task) || taskDueDate(task)
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999)
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
}

function dateStamp(date) {
  var month = date.getMonth() + 1
  var day = date.getDate()
  return date.getFullYear() * 10000 + month * 100 + day
}

function stampToDate(stamp) {
  var text = String(stamp)
  if (text.length !== 8) return null
  return new Date(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8)))
}

// ---- tasks -------------------------------------------------------------

// ---- views -------------------------------------------------------------
//
// A view is what the panel lists, written as one string so it can live in a
// setting: a date range ("Today", "Tomorrow", "Week", "Month"), a smart list
// ("All", "No date", "Inbox"), or a list or folder by id ("list:<id>",
// "folder:<id>"). Week and Month are rolling — today plus six or twenty-nine
// days — the same shape as TickTick's own "Next 7 Days".

var DATE_VIEWS = ["Today", "Tomorrow", "Week", "Month"]
var SMART_VIEWS = ["Today", "Tomorrow", "Week", "Month", "All", "No date", "Inbox"]

// What `V` and a click on the range dots step through. The full set,
// lists included, is behind the picker.
var QUICK_VIEWS = ["Today", "Week", "Month"]

// Names this plugin's settings have used, and spellings a hand-edited
// shell.json is likely to carry.
var VIEW_ALIASES = {
  "next 7 days": "Week", "7 days": "Week", "next7days": "Week", "this week": "Week",
  "next 30 days": "Month", "30 days": "Month", "this month": "Month",
  "nodate": "No date", "no due date": "No date", "undated": "No date",
  "everything": "All"
}

function quickViews() {
  return QUICK_VIEWS
}

function viewKind(view) {
  var text = String(view || "")
  if (text.indexOf("list:") === 0) return "list"
  if (text.indexOf("folder:") === 0) return "folder"
  if (DATE_VIEWS.indexOf(text) >= 0) return "date"
  if (text === "All") return "all"
  if (text === "No date") return "nodate"
  if (text === "Inbox") return "inbox"
  return "date"
}

function viewRef(view) {
  var text = String(view || "")
  var colon = text.indexOf(":")
  return colon < 0 ? "" : text.slice(colon + 1)
}

function isDateView(view) {
  return DATE_VIEWS.indexOf(String(view)) >= 0
}

// Days past today a date view reaches. Tomorrow is special-cased in
// viewTasks: it starts tomorrow rather than today.
function horizonDays(view) {
  var name = normalizeView(view)
  if (name === "Tomorrow") return 1
  if (name === "Week") return 6
  if (name === "Month") return 29
  return 0
}

// A setting value as a view, without knowing the lists yet. Smart names are
// matched case-insensitively; anything unrecognised is Today, because a
// typo in shell.json should open the panel on something useful rather than
// on nothing.
function normalizeView(value) {
  var text = String(value === undefined || value === null ? "" : value).trim()
  if (text === "") return "Today"
  var lower = text.toLowerCase()
  if (lower.indexOf("list:") === 0) return "list:" + text.slice(5).trim()
  if (lower.indexOf("folder:") === 0) return "folder:" + text.slice(7).trim()
  if (VIEW_ALIASES[lower]) return VIEW_ALIASES[lower]
  for (var i = 0; i < SMART_VIEWS.length; i++) {
    if (SMART_VIEWS[i].toLowerCase() === lower) return SMART_VIEWS[i]
  }
  return "Today"
}

// TickTick list names often lead with an emoji ("💼Work"), which nobody
// types into a setting. Names are compared with that stripped, after an
// exact match has had its chance.
var LEADING_EMOJI = /^[\uD800-\uDFFF\u2000-\u2BFF\uFE00-\uFE0F\u200D\s]+/

function nameKey(name) {
  return String(name || "").trim().toLowerCase().replace(LEADING_EMOJI, "")
}

function findByRef(items, ref) {
  var needle = String(ref || "").trim()
  if (needle === "") return null
  var lower = needle.toLowerCase()
  var key = nameKey(needle)
  var byName = null
  var byKey = null
  for (var i = 0; i < (items || []).length; i++) {
    var item = items[i]
    if (!item) continue
    if (item.id === needle) return item
    if (!byName && String(item.name || "").trim().toLowerCase() === lower) byName = item
    if (!byKey && key !== "" && nameKey(item.name) === key) byKey = item
  }
  return byName || byKey
}

// A setting value as a concrete view: `list:Work` becomes `list:<id>` once
// the lists are known, and a list that no longer exists (deleted, closed,
// renamed away) falls back to Today. Before the first sync there are no
// lists to check against, so a list reference is kept rather than thrown
// away on a cold start.
function resolveView(value, projects, groups) {
  var view = normalizeView(value)
  var kind = viewKind(view)
  if (kind !== "list" && kind !== "folder") return view
  var pool = kind === "list" ? projects : groups
  if (!pool || pool.length === 0) return view
  var found = findByRef(pool, viewRef(view))
  if (!found || found.closed) return "Today"
  return kind + ":" + found.id
}

function viewTitle(view, projects, groups) {
  var kind = viewKind(view)
  if (kind === "list" || kind === "folder") {
    var found = findByRef(kind === "list" ? projects : groups, viewRef(view))
    return found ? String(found.name || "") : viewRef(view)
  }
  return normalizeView(view)
}

function cycleView(current, delta) {
  var i = QUICK_VIEWS.indexOf(String(current))
  var step = delta || 1
  // From a list, forward lands on the first range and back on the last.
  if (i < 0) return step > 0 ? QUICK_VIEWS[0] : QUICK_VIEWS[QUICK_VIEWS.length - 1]
  var next = (i + step) % QUICK_VIEWS.length
  if (next < 0) next += QUICK_VIEWS.length
  return QUICK_VIEWS[next]
}

// The narrowest range that would still show a task due on `dueWord`. Used so
// adding "…next friday" from a Today view does not file the task somewhere
// the user cannot see it.
var WIDTH_ORDER = ["Today", "Week", "Month", "All"]

function viewForDue(dueWord, now) {
  var word = String(dueWord || "today").toLowerCase()
  if (word === "today" || word === "yesterday") return "Today"
  if (word === "tomorrow") return "Week"
  var parts = word.split("-")
  if (parts.length === 3) {
    var target = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    if (!isNaN(target.getTime())) {
      var days = dayDelta(target, now || new Date())
      if (days <= 0) return "Today"
      if (days <= 6) return "Week"
      if (days <= 29) return "Month"
      return "All"
    }
  }
  return "Today"
}

// Only ever widens a date range. A list view shows every date already, so
// it is left where the user put it.
function widerView(current, wanted) {
  var kind = viewKind(current)
  if (kind !== "date") return current
  var a = WIDTH_ORDER.indexOf(current === "Tomorrow" ? "Week" : current)
  var b = WIDTH_ORDER.indexOf(wanted)
  if (b < 0) return current
  if (current === "Tomorrow") return b <= a ? current : wanted
  return a >= b ? current : wanted
}

// The quick-add due word a view implies when the line names none: adding
// from the Tomorrow list makes a task for tomorrow, the way it does in
// TickTick. Lists and the undated view add undated tasks.
function defaultDueForView(view) {
  if (view === "Tomorrow") return "tomorrow"
  if (viewKind(view) === "date") return "today"
  return ""
}

function dayDelta(date, now) {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86400000)
}

// TickTick's ordinary recurring task carries an RRULE in repeatFlag, but a
// series that repeats from completion can leave that flag empty and retain
// only its relationship fields. repeatFrom 0 also appears on plain tasks, so
// only a non-zero mode is meaningful by itself.
function isRecurringTask(task) {
  if (!task || typeof task !== "object") return false
  if (task.repeatTaskId || task.repeatFirstDate) return true
  if (task.repeatFrom !== undefined && task.repeatFrom !== null
      && String(task.repeatFrom) !== "" && String(task.repeatFrom) !== "0") return true
  return String(task.repeatFlag || "").trim() !== ""
}

function isOpen(task) {
  return task && task.status !== STATUS_DONE && task.status !== STATUS_WONT_DO && !task.deleted
}

// Late is a day, not an hour. A task due at 10:30 today is still today's
// work at 18:00: the panel is a day's list, and marking it late there --
// painting it, counting it, filing it under the backlog rule -- says the
// same thing about it as about something due last March. The hour still
// shows in the row's own label, which is where it means something.
function isOverdue(task, now) {
  var due = taskDueDate(task)
  if (!due) return false
  return dateStamp(due) < dateStamp(now)
}

// Tasks worth showing: open, dated, and landing inside the range —
// plus anything already late when the user asked to see late work. The
// Tomorrow range is tomorrow alone, as in TickTick; the rest start today.
function dueTasks(tasks, options) {
  var opts = options || {}
  var now = opts.now || new Date()
  var view = normalizeView(opts.horizon)
  var tomorrowOnly = view === "Tomorrow"
  var includeOverdue = opts.includeOverdue !== false && !tomorrowOnly
  var cutoff = endOfDay(addDays(now, horizonDays(view))).getTime()
  var floor = tomorrowOnly ? startOfDay(addDays(now, 1)).getTime() : -Infinity

  var result = []
  for (var i = 0; i < (tasks || []).length; i++) {
    var task = tasks[i]
    if (!isOpen(task)) continue

    var due = taskDueDate(task)
    if (!due) continue

    var late = isOverdue(task, now)
    if (late && !includeOverdue) continue

    var dueValue = task.isAllDay ? endOfDay(due).getTime() : taskTimeKey(task).getTime()
    if (!late && dueValue > cutoff) continue
    if (!late && dueValue < floor) continue

    result.push(task)
  }

  result.sort(compareByDue(now))
  return result
}

// The panel's natural order. Undated tasks — which only list views show —
// go after every dated one, in TickTick's manual order.
function compareByDue(now) {
  return function(a, b) {
    var aDue = taskDueDate(a) ? 0 : 1
    var bDue = taskDueDate(b) ? 0 : 1
    if (aDue !== bDue) return aDue - bDue
    if (aDue === 1) return comparePriorityThenManual(a, b)

    // Today first, the backlog under it. A long backlog otherwise fills the
    // panel's row budget on its own and today's work never reaches the list
    // -- the count of late work is already in the header, and a task that
    // has been late for months is not more urgent than the meeting at noon.
    var aLate = isOverdue(a, now) ? 1 : 0
    var bLate = isOverdue(b, now) ? 1 : 0
    if (aLate !== bLate) return aLate - bLate

    // Inside the backlog the newest slip comes first: what went late
    // yesterday is still the work you meant to do, while something a year
    // late is a decision to take, not a row to act on this morning.
    if (aLate === 1) {
      var aSlip = taskTimeKey(a)
      var bSlip = taskTimeKey(b)
      var aSlipTime = aSlip ? aSlip.getTime() : 0
      var bSlipTime = bSlip ? bSlip.getTime() : 0
      if (aSlipTime !== bSlipTime) return bSlipTime - aSlipTime
    }

    // Day before anything else, so a later day's appointment never jumps
    // ahead of today's all-day task in a Week or Month view.
    var aDay = dateStamp(taskTimeKey(a))
    var bDay = dateStamp(taskTimeKey(b))
    if (aDay !== bDay) return aDay - bDay

    // A duration is an appointment: it is pinned to a moment you have to
    // show up for, while a plain due time floats anywhere in its day. Among
    // everything that is not late, the pinned moments go first — otherwise
    // an evening block drowns under every all-day task, whose key is
    // midnight and so always sorts ahead by time alone.
    var aSpan = taskStartDate(a) ? 0 : 1
    var bSpan = taskStartDate(b) ? 0 : 1
    if (aSpan !== bSpan) return aSpan - bSpan

    var aKey = taskTimeKey(a)
    var bKey = taskTimeKey(b)
    var aTime = aKey ? aKey.getTime() : 0
    var bTime = bKey ? bKey.getTime() : 0
    if (aTime !== bTime) return aTime - bTime

    return comparePriorityThenManual(a, b)
  }
}

// TickTick's own tiebreak: higher priority first, then manual order.
function comparePriorityThenManual(a, b) {
  var aPriority = Number(a.priority || 0)
  var bPriority = Number(b.priority || 0)
  if (aPriority !== bPriority) return bPriority - aPriority
  return Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
}

// ---- lists, filters, grouping ------------------------------------------

var SORT_MODES = ["Due", "Priority", "Title", "Manual"]
var GROUP_MODES = ["Date", "List", "Priority", "None"]
var PRIORITY_FILTERS = [0, 1, 3, 5]

function cycleMode(modes, current) {
  var i = modes.indexOf(String(current))
  return modes[(i + 1) % modes.length]
}

function cycleSort(current) { return cycleMode(SORT_MODES, current) }
function cycleGroup(current) { return cycleMode(GROUP_MODES, current) }

function cyclePriorityFilter(current) {
  var i = PRIORITY_FILTERS.indexOf(Number(current || 0))
  return PRIORITY_FILTERS[(i + 1) % PRIORITY_FILTERS.length]
}

function priorityFilterLabel(value) {
  var n = Number(value || 0)
  if (n >= 5) return "High"
  if (n >= 3) return "Medium+"
  if (n >= 1) return "Low+"
  return "Any priority"
}

// Steps through the tags in TickTick's order, then back to no filter.
function cycleTagFilter(tags, current) {
  var names = []
  var sorted = (tags || []).slice().sort(function(a, b) {
    return Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
  })
  for (var i = 0; i < sorted.length; i++) if (sorted[i].name) names.push(sorted[i].name)
  if (names.length === 0) return ""
  var at = names.indexOf(String(current || ""))
  return at + 1 >= names.length ? "" : names[at + 1]
}

function taskHasTag(task, tag) {
  var tags = (task && task.tags) || []
  for (var i = 0; i < tags.length; i++) if (String(tags[i]).toLowerCase() === tag) return true
  return false
}

// Everything a view lists, filtered and sorted. `opts` carries `now`,
// `includeOverdue`, `projects`, `inboxId`, the filters `tag` and
// `minPriority`, and `sortBy`.
function viewTasks(tasks, view, options) {
  var opts = options || {}
  var now = opts.now || new Date()
  var kind = viewKind(view)
  var ref = viewRef(view)
  var result

  if (kind === "date") {
    result = dueTasks(tasks, { now: now, horizon: view, includeOverdue: opts.includeOverdue })
  } else {
    var folderLists = {}
    if (kind === "folder") {
      var projects = opts.projects || []
      for (var p = 0; p < projects.length; p++) {
        if (projects[p].groupId === ref) folderLists[projects[p].id] = true
      }
    }
    result = []
    for (var i = 0; i < (tasks || []).length; i++) {
      var task = tasks[i]
      if (!isOpen(task)) continue
      if (kind === "nodate" && taskDueDate(task)) continue
      if (kind === "inbox" && task.projectId !== opts.inboxId) continue
      if (kind === "list" && task.projectId !== ref) continue
      if (kind === "folder" && !folderLists[task.projectId]) continue
      result.push(task)
    }
  }

  var tag = String(opts.tag || "").toLowerCase()
  var minPriority = Number(opts.minPriority || 0)
  if (tag !== "" || minPriority > 0) {
    result = result.filter(function(task) {
      if (tag !== "" && !taskHasTag(task, tag)) return false
      return Number(task.priority || 0) >= minPriority
    })
  }

  return sortTasks(result, opts.sortBy, now)
}

function sortTasks(tasks, sortBy, now) {
  var byDue = compareByDue(now || new Date())
  var list = (tasks || []).slice()
  if (sortBy === "Priority") {
    list.sort(function(a, b) {
      var d = Number(b.priority || 0) - Number(a.priority || 0)
      return d !== 0 ? d : byDue(a, b)
    })
  } else if (sortBy === "Title") {
    list.sort(function(a, b) {
      var d = String(a.title || "").toLowerCase().localeCompare(String(b.title || "").toLowerCase())
      return d !== 0 ? d : byDue(a, b)
    })
  } else if (sortBy === "Manual") {
    list.sort(function(a, b) {
      var d = Number(a.sortOrder || 0) - Number(b.sortOrder || 0)
      return d !== 0 ? d : byDue(a, b)
    })
  } else {
    list.sort(byDue)
  }
  return list
}

// Which date bucket a task falls in, for the Date grouping and the dots.
function dateBucket(task, now) {
  var due = taskDueDate(task)
  if (!due) return "nodate"
  if (isOverdue(task, now)) return "overdue"
  var days = dayDelta(taskTimeKey(task) || due, now)
  if (days <= 0) return "today"
  if (days === 1) return "tomorrow"
  if (days <= 6) return "week"
  return "later"
}

var DATE_GROUPS = [
  { key: "overdue", title: "Overdue" },
  { key: "today", title: "Today" },
  { key: "tomorrow", title: "Tomorrow" },
  { key: "week", title: "Next 7 days" },
  { key: "later", title: "Later" },
  { key: "nodate", title: "No date" }
]

var PRIORITY_GROUPS = [
  { key: "high", title: "High priority" },
  { key: "medium", title: "Medium priority" },
  { key: "low", title: "Low priority" },
  { key: "none", title: "No priority" }
]

// Sections in the order they should render, each keeping the order the
// tasks arrived in. Empty sections are dropped. `ctx` carries `now`,
// `projects`, `groups` and `inboxId` (the last three for list grouping).
function groupTasks(tasks, groupBy, ctx) {
  var context = ctx || {}
  var now = context.now || new Date()
  var list = tasks || []
  if (groupBy !== "Date" && groupBy !== "List" && groupBy !== "Priority") {
    return list.length ? [{ key: "all", title: "", tasks: list.slice() }] : []
  }

  var order
  var keyOf
  if (groupBy === "Date") {
    order = DATE_GROUPS
    keyOf = function(task) { return dateBucket(task, now) }
  } else if (groupBy === "Priority") {
    order = PRIORITY_GROUPS
    keyOf = function(task) { return priorityRank(task) }
  } else {
    order = []
    var entries = viewOrder(context.projects, context.groups, context.inboxId, true)
    for (var e = 0; e < entries.length; e++) {
      if (entries[e].kind === "list" || entries[e].view === "Inbox") {
        order.push({ key: entries[e].view === "Inbox" ? context.inboxId : viewRef(entries[e].view),
                     title: entries[e].title })
      }
    }
    keyOf = function(task) { return task.projectId || "" }
  }

  var buckets = {}
  for (var i = 0; i < list.length; i++) {
    var key = keyOf(list[i])
    if (!buckets[key]) buckets[key] = []
    buckets[key].push(list[i])
  }

  var result = []
  var seen = {}
  for (var o = 0; o < order.length; o++) {
    var k = order[o].key
    if (buckets[k] && !seen[k]) {
      result.push({ key: k, title: order[o].title, tasks: buckets[k] })
      seen[k] = true
    }
  }
  // A task in a list the sidebar does not know (closed, or shared and not
  // yet synced) still belongs somewhere.
  for (var rest in buckets) {
    if (!seen[rest]) result.push({ key: rest, title: groupBy === "List" ? "Other" : rest, tasks: buckets[rest] })
  }
  return result
}

// Overdue, due today, and due in the rest of the week, across every list.
// This is the bar icon's state, so it ignores whatever the panel is
// filtered to: a dot is a promise about the whole account. `excludeIds`
// holds tasks whose completion is waiting out its undo window.
function statusCounts(tasks, now, excludeIds) {
  var skip = {}
  for (var x = 0; x < (excludeIds || []).length; x++) skip[excludeIds[x]] = true
  var counts = { overdue: 0, today: 0, week: 0 }
  for (var i = 0; i < (tasks || []).length; i++) {
    var task = tasks[i]
    if (!isOpen(task) || skip[task.id]) continue
    var bucket = dateBucket(task, now || new Date())
    if (bucket === "overdue") counts.overdue++
    else if (bucket === "today") counts.today++
    else if (bucket === "tomorrow" || bucket === "week") counts.week++
  }
  return counts
}

function statusDots(tasks, now, excludeIds) {
  var c = statusCounts(tasks, now, excludeIds)
  return { overdue: c.overdue > 0, today: c.today > 0, week: c.week > 0 }
}

function statusSummary(counts) {
  var parts = []
  if (counts.overdue > 0) parts.push(counts.overdue + " overdue")
  if (counts.today > 0) parts.push(counts.today + " today")
  if (counts.week > 0) parts.push(counts.week + " this week")
  return parts.length ? parts.join(" · ") : "nothing due this week"
}

// The picker, top to bottom: date ranges and smart lists, then Inbox, then
// each folder with its lists under it, then lists outside any folder — in
// TickTick's own sidebar order. Closed lists are left out. `listsOnly`
// drops the date ranges and smart lists, which is what a move needs.
function viewOrder(projects, groups, inboxId, listsOnly) {
  var entries = []
  if (!listsOnly) {
    var smart = ["Today", "Tomorrow", "Week", "Month", "All", "No date"]
    for (var s = 0; s < smart.length; s++) {
      entries.push({ view: smart[s], title: smart[s], kind: "smart", depth: 0, color: "" })
    }
  }
  if (inboxId) entries.push({ view: "Inbox", title: "Inbox", kind: "inbox", depth: 0, color: "", projectId: inboxId })

  var bySort = function(a, b) { return Number(a.sortOrder || 0) - Number(b.sortOrder || 0) }
  var open = (projects || []).filter(function(p) {
    return p && p.id && !p.closed && p.id !== inboxId && !p.inbox
  }).sort(bySort)
  var folders = (groups || []).filter(function(g) { return g && g.id }).sort(bySort)

  var listEntry = function(p, depth) {
    return { view: "list:" + p.id, title: String(p.name || ""), kind: "list", depth: depth,
             color: p.color || "", projectId: p.id }
  }

  // Folders and loose lists share one sort order in TickTick's sidebar, so
  // they are interleaved rather than stacked.
  var top = []
  var knownFolder = {}
  for (var f = 0; f < folders.length; f++) {
    knownFolder[folders[f].id] = true
    top.push({ folder: folders[f], sortOrder: folders[f].sortOrder })
  }
  for (var p = 0; p < open.length; p++) {
    if (!open[p].groupId || !knownFolder[open[p].groupId]) top.push({ list: open[p], sortOrder: open[p].sortOrder })
  }
  top.sort(bySort)

  for (var t = 0; t < top.length; t++) {
    if (top[t].list) {
      entries.push(listEntry(top[t].list, 0))
      continue
    }
    var folder = top[t].folder
    var members = open.filter(function(p) { return p.groupId === folder.id })
    if (members.length === 0) continue
    entries.push({ view: "folder:" + folder.id, title: String(folder.name || ""), kind: "folder", depth: 0, color: "" })
    for (var m = 0; m < members.length; m++) entries.push(listEntry(members[m], 1))
  }
  return entries
}

function nextTaskTitle(tasks) {
  var next = nextTask(tasks)
  return next ? String(next.title || "") : ""
}

function nextTask(tasks) {
  return (tasks && tasks.length > 0) ? tasks[0] : null
}

function dueLabel(task, now) {
  var due = taskDueDate(task)
  if (!due) return ""
  var reference = now || new Date()
  var dayDelta = Math.round((startOfDay(due).getTime() - startOfDay(reference).getTime()) / 86400000)

  if (task.isAllDay) {
    if (dayDelta === 0) return "Today"
    if (dayDelta === 1) return "Tomorrow"
    if (dayDelta === -1) return "Yesterday"
    if (dayDelta < 0) return Math.abs(dayDelta) + "d late"
    return dayDelta + "d"
  }

  // A duration shows the whole block, and the day marker follows the start:
  // the question the label answers is "when does this begin". A past span
  // stays compact — how long it ran matters less than how late it is.
  var start = taskStartDate(task)
  if (start) {
    var startDelta = Math.round((startOfDay(start).getTime() - startOfDay(reference).getTime()) / 86400000)
    var range = clockLabel(start) + "–" + clockLabel(due)
    if (startDelta === 0) return range
    if (startDelta === 1) return "Tmw " + range
    if (startDelta === -1) return "Yst " + range
    if (startDelta < 0) return Math.abs(startDelta) + "d late"
    return startDelta + "d " + range
  }

  var clock = clockLabel(due)
  if (dayDelta === 0) return clock
  if (dayDelta === 1) return "Tmw " + clock
  if (dayDelta === -1) return "Yst " + clock
  if (dayDelta < 0) return Math.abs(dayDelta) + "d late"
  return dayDelta + "d " + clock
}

function clockLabel(date) {
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes())
}

function pad2(value) {
  return value < 10 ? "0" + value : String(value)
}

// ---- task details ------------------------------------------------------

// A task carries its long form in `content` and its checklist in `items`.
// Both are optional, so the row's affordance (and the key that opens it)
// should only exist when there is something behind them.
function hasDetails(task) {
  if (!task) return false
  if (String(task.content || "").trim() !== "") return true
  return subtasks(task).length > 0
}

// TickTick keeps every subtask ever typed in `items`, including ones whose
// title was later cleared. Those would render as a checkbox with no name,
// so they are filtered here — the one place every reader and counter
// shares. Status 0 is open; anything else TickTick has used means done.
function subtasks(task) {
  var items = (task && task.items) || []
  var result = []
  for (var i = 0; i < items.length; i++) {
    var title = String((items[i] && items[i].title) || "").trim()
    if (title === "") continue
    result.push({
      id: String(items[i].id || ""),
      title: title,
      done: Number(items[i].status || 0) !== 0
    })
  }
  return result
}

// The task as a standalone markdown note: heading, one line of metadata,
// the description verbatim, then the checklist. Shaped for handing a task
// to somewhere that has never heard of TickTick.
function taskMarkdown(task, projects, inboxId, now) {
  if (!task) return ""
  var lines = ["# " + plainText(String(task.title || "Untitled"))]

  var meta = []
  var project = projectName(projects, task.projectId, inboxId)
  if (project) meta.push(project)
  var names = task.tags || []
  for (var i = 0; i < names.length; i++) meta.push("#" + String(names[i]))
  var rank = priorityRank(task)
  if (rank !== "none") meta.push(rank + " priority")
  var due = dueLabel(task, now)
  if (due !== "") meta.push("due " + due)
  if (meta.length > 0) lines.push("", meta.join(" · "))

  var content = String(task.content || "").trim()
  if (content !== "") lines.push("", content)

  var items = subtasks(task)
  if (items.length > 0) {
    lines.push("")
    for (var j = 0; j < items.length; j++) {
      lines.push((items[j].done ? "- [x] " : "- [ ] ") + plainText(items[j].title))
    }
  }

  return lines.join("\n") + "\n"
}

// TickTick priorities: 0 none, 1 low, 3 medium, 5 high.
function priorityRank(task) {
  var value = Number((task && task.priority) || 0)
  if (value >= 5) return "high"
  if (value >= 3) return "medium"
  if (value >= 1) return "low"
  return "none"
}

function projectName(projects, projectId, inboxId) {
  if (projectId && projectId === inboxId) return "Inbox"
  for (var i = 0; i < (projects || []).length; i++) {
    if (projects[i].id === projectId) return projects[i].name || ""
  }
  return ""
}

// ---- tags --------------------------------------------------------------

// Tasks reference tags by their lowercase `name`; the colour lives on the
// tag object. A task can carry several, and the first one in TickTick's own
// order is the one its apps lead with, so that is the dot we paint.
function tagIndex(tags) {
  var index = {}
  for (var i = 0; i < (tags || []).length; i++) {
    var tag = tags[i]
    if (tag && tag.name) index[String(tag.name)] = tag
  }
  return index
}

function firstTag(task, index) {
  var names = (task && task.tags) || []
  for (var i = 0; i < names.length; i++) {
    var tag = index[String(names[i])]
    if (tag) return tag
  }
  return null
}

function tagColor(task, index) {
  var tag = firstTag(task, index)
  return tag && tag.color ? String(tag.color) : ""
}

function tagLabel(task, index) {
  var tag = firstTag(task, index)
  return tag ? String(tag.label || tag.name || "") : ""
}

// ---- sync interval -----------------------------------------------------

// Labels rather than a number field. A free-form seconds box invites values
// that are either pointless or rude to the API: tasks do not change
// second-to-second, and every tick costs five requests per bar.
var SYNC_INTERVALS = {
  "2 minutes": 120,
  "5 minutes": 300,
  "15 minutes": 900,
  "1 hour": 3600,
  "Only when opened": 0
}

function syncIntervalSeconds(label) {
  var seconds = SYNC_INTERVALS[String(label)]
  return seconds === undefined ? 300 : seconds
}

function syncIntervalLabels() {
  return ["2 minutes", "5 minutes", "15 minutes", "1 hour", "Only when opened"]
}

// ---- quick add ---------------------------------------------------------

// Inline syntax for the quick-add field. `#tag` and plain date words are
// TickTick's own conventions, so they behave the way its apps taught you.
// `!` for priority is this plugin's: TickTick has no quick-add symbol for
// it, so nothing is being contradicted by inventing one. A trailing clock
// time ("21:00", "9pm", "today 21:00-22:30") sets when — a range becomes a
// duration, a lone time becomes a due hour.
var PRIORITY_WORDS = {
  "1": 5, "high": 5, "h": 5,
  "2": 3, "medium": 3, "med": 3, "m": 3,
  "3": 1, "low": 1, "l": 1,
  "0": 0, "none": 0
}

var DATE_WORD = "(today|tomorrow|yesterday|\\d{4}-\\d{2}-\\d{2})"
// A bare "9" is deliberately not a time — a title can end with a number.
// An hour must carry a colon ("21:00", "9:30am") or a meridiem ("9pm").
// The space in "9 pm" is optional because that is how people type it; the
// meridiem still has to end the line, so "Buy 2 amps" is not 02:00.
var TIME_WORD = "(\\d{1,2}:\\d{2}(?:\\s*(?:am|pm))?|\\d{1,2}\\s*(?:am|pm))"
var TIME_RANGE = TIME_WORD + "(?:\\s*-\\s*" + TIME_WORD + ")?"
// Filler that belongs to the date rather than the title. Without it, "notes
// for today" becomes a task called "notes for" — and "at", the most natural
// word before a clock, used to be the one left stranded there.
//
// `\s+` and not `\s`: stripping a mid-line "#tag" or "!1" leaves the space on
// both sides of it behind, so "Review tomorrow #work 09:00" reaches here as
// "Review tomorrow  09:00". A single-space LEAD does not bridge that gap, and
// the day word ends up in the title with the task due today.
var LEAD = "\\s+(?:for\\s+|on\\s+|due\\s+|by\\s+|at\\s+|@\\s*)?"

// The same filler in front of a day word, minus "at". "at" belongs in front
// of a clock — "Call mum at 9pm" — but in front of a day it is nearly always
// the end of a title: "Look at today" is a task called "Look at", and taking
// the word there also made an unchanged edit of any such task rename it,
// because the edit line is the title followed by its day. "@" is taken only
// attached — "standup @tomorrow" is shorthand — since a spaced one ("Ping @
// today") is how a title ending in "@" comes back from the edit line.
var DATE_LEAD = "\\s+(?:for\\s+|on\\s+|due\\s+|by\\s+|@(?=\\S))?"

// A trailing hour, an optional minute and meridiem, and a range separator: the
// front half of a range this grammar cannot read, as it sits at the end of the
// text before a clock ("gym 6 -", "call 10 to").
var HALF_RANGE = /(?:^|\s)\d{1,2}(?::\d{2})?(?:\s*(?:am|pm))?\s*(?:[-–—]|to|til|till|until|thru|through)\s*$/i

// A single clock spelled the way this field has always read it: meridiem
// glued on, and a space right before it. Whatever filler now sits in front
// ("at 9pm") does not change that the clock itself was always taken.
var ESTABLISHED_CLOCK = /(?:^|\s)(?:\d{1,2}:\d{2}(?:am|pm)?|\d{1,2}(?:am|pm))\s*$/i

// A clock this grammar would read on its own, anywhere in a line. Only a
// trailing one is taken, so one left in the title — "Dentist 3pm tomorrow" —
// is a time that was not set, and the hint has to say so.
var CLOCK_IN_TEXT = /(?:^|\s)(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|\d{1,2}\s*(?:am|pm))(?=$|\s|[-–—.,;:!?)])/i

// "9pm" → "21:00", "9:30am" → "09:30". Anything that is not a real clock
// returns null, and the token stays in the title rather than being eaten.
function toClock24(token) {
  // "1:33 am" and "1:33am" are the same clock; the space is the typist's,
  // not the grammar's.
  var text = String(token).toLowerCase().replace(/\s+/g, "")

  var clock = text.match(/^(\d{1,2}):(\d{2})(am|pm)?$/)
  if (clock) {
    var hour = Number(clock[1])
    var minute = Number(clock[2])
    if (clock[3] === "pm" && hour < 12) hour += 12
    if (clock[3] === "am" && hour === 12) hour = 0
    if (hour > 23 || minute > 59) return null
    return pad2(hour) + ":" + pad2(minute)
  }

  var meridiem = text.match(/^(\d{1,2})(am|pm)$/)
  if (!meridiem) return null
  var hour12 = Number(meridiem[1])
  if (hour12 < 1 || hour12 > 12) return null
  if (meridiem[2] === "pm" && hour12 < 12) hour12 += 12
  if (meridiem[2] === "am" && hour12 === 12) hour12 = 0
  return pad2(hour12) + ":00"
}

// "a:b" → minutes. The CLI rebuilds instants from these, so they stay plain.
function clockMinutes(clock) {
  var parts = String(clock).split(":")
  return Number(parts[0]) * 60 + Number(parts[1])
}

function parseQuickAdd(text) {
  var rest = String(text || "")
  var tags = []
  var priority = 0
  var due = "today"
  var dueGiven = false
  var time = null

  rest = rest.replace(/(^|\s)#([^\s#]+)/g, function(match, lead, tag) {
    tags.push(String(tag).toLowerCase())
    return lead
  })

  rest = rest.replace(/(^|\s)!([A-Za-z0-9]+)/g, function(match, lead, word) {
    var mapped = PRIORITY_WORDS[String(word).toLowerCase()]
    if (mapped === undefined) return match
    priority = mapped
    return lead
  })

  // Only a trailing date/time blob is treated as one. "Call mum today" sets
  // a date; "Plan today's standup" keeps its word. The preposition goes
  // with the date — without that, "notes for today" becomes a task called
  // "notes for".
  var dateToken = null
  var startClock = null
  var endClock = null
  var endGiven = false

  // Filler twice, not once: it can sit before the date ("due tomorrow") and
  // again before the clock ("tomorrow at 9:15"). With a plain space here,
  // "tomorrow at 9:15" matched only the clock and left the day in the title —
  // a task named "Standup tomorrow", scheduled today.
  var dateAndTime = rest.match(new RegExp(DATE_LEAD + DATE_WORD + LEAD + TIME_RANGE + "\\s*$", "i"))
  var dateOnly = dateAndTime ? null : rest.match(new RegExp(DATE_LEAD + DATE_WORD + "\\s*$", "i"))
  var timeOnly = dateAndTime || dateOnly ? null : rest.match(new RegExp(LEAD + TIME_RANGE + "\\s*$", "i"))

  if (dateAndTime) {
    dateToken = dateAndTime[1].toLowerCase()
    startClock = toClock24(dateAndTime[2])
    if (dateAndTime[3]) {
      endGiven = true
      endClock = toClock24(dateAndTime[3])
    }
  } else if (dateOnly) {
    dateToken = dateOnly[1].toLowerCase()
  } else if (timeOnly) {
    startClock = toClock24(timeOnly[1])
    if (timeOnly[2]) {
      endGiven = true
      endClock = toClock24(timeOnly[2])
    }
  }

  // A clock that is not a clock — "25:00", "9-10" with no colon — is just a
  // word. The whole trailing blob stays in the title and nothing is set,
  // which is also what keeps a title like "Finish 3" out of the parser.
  //
  // `timeRejected` remembers that this happened. The line looked like it
  // carried a clock and does not, which is the one case the hint under the
  // field cannot show as a date alone: "Today" reads the same whether you
  // typed no time or typed one this grammar would not take.
  var timeRejected = false
  if (dateAndTime && (startClock === null || (endGiven && endClock === null))) {
    timeRejected = true
    dateToken = null
    startClock = null
    endClock = null
  }
  if (timeOnly && (startClock === null || (endGiven && endClock === null))) {
    timeRejected = true
    startClock = null
    endClock = null
  }

  var matched = dateAndTime || dateOnly || timeOnly

  // A clock is not taken when the text just before it is the front half of a
  // range this grammar cannot read. A range here is a hyphen between two
  // clocks; in "gym 6 - 7 am" the "6" is a number, not six o'clock, so only
  // the tail matches, and taking it would name the task "gym 6 -" and remind
  // at 07:00 — the END of the block — while the hint said it had worked.
  //
  // Only a single clock spelled in a way this field has not always read is
  // refused. A glued clock straight after the title — "Level 3 - 9pm" — has
  // always been taken, and it is as often a real title with a real time as a
  // half-typed range; refusing it would silently stop a reminder that works
  // today. That spelling keeps its clock, and the hint shows the name the task
  // will get, which is where a half-read range gives itself away. A whole
  // range, or a match that took a day word, is never half of anything.
  if (matched && matched === timeOnly && endClock === null
      && !ESTABLISHED_CLOCK.test(matched[0])
      && HALF_RANGE.test(rest.slice(0, matched.index))) {
    matched = null
    timeRejected = true
  }

  if (matched && (dateToken !== null || startClock !== null)) {
    if (dateToken !== null) due = dateToken
    time = startClock === null ? null : (endClock !== null ? startClock + "-" + endClock : startClock)
    dueGiven = true
    rest = rest.slice(0, matched.index)
  }

  var title = rest.replace(/\s+/g, " ").trim()
  return {
    title: title,
    tags: tags,
    priority: priority,
    due: due,
    dueGiven: dueGiven,
    time: time,
    timeRejected: time === null && (timeRejected || CLOCK_IN_TEXT.test(title))
  }
}

// The inverse: render a task back into the line that would have produced it,
// so editing is the same grammar as adding rather than a second syntax to
// learn. A duration comes back as a range — which is what keeps one alive
// across an edit: the field pre-fills with the times, and whatever the line
// then says is what the task becomes.
function editLineFor(task, index) {
  if (!task) return ""
  var parts = [String(task.title || "")]

  var names = (task.tags || [])
  for (var i = 0; i < names.length; i++) parts.push("#" + String(names[i]))

  var rank = priorityRank(task)
  if (rank === "high") parts.push("!1")
  else if (rank === "medium") parts.push("!2")
  else if (rank === "low") parts.push("!3")

  var due = taskDueDate(task)
  if (due) {
    var start = taskStartDate(task)
    var anchor = start || due
    var delta = Math.round((startOfDay(anchor).getTime() - startOfDay(new Date()).getTime()) / 86400000)
    var tail = delta === 0 ? "today"
      : delta === 1 ? "tomorrow"
      : delta === -1 ? "yesterday"
      : anchor.getFullYear() + "-" + pad2(anchor.getMonth() + 1) + "-" + pad2(anchor.getDate())
    if (!task.isAllDay) {
      tail += " " + (start
        ? clockLabel(start) + "-" + clockLabel(due)
        : clockLabel(due))
    }
    parts.push(tail)
  }

  return parts.join(" ")
}

// What the line means as an edit. Tags, priority, and the schedule are
// always sent, because deleting "#work" (or the clock) from the line is how
// a tag (or a duration) is removed; an undated, untimed line sends neither.
// The words the day and clock grammar takes off the end of a title.
var TITLE_FILLER_TAIL = /^(?:\s+(?:for|on|by|due|at|@))+$/i

// What an edit line means, given the name the task had when the field was
// opened. The line is the title followed by its day, and "for", "on", "by" and
// "due" in front of a day are filler — so a task called "Notes for" would come
// back as "Notes" from an edit that never touched its name.
//
// The old name is kept only for exactly that loss: the parser dropped nothing
// but trailing filler words, and the line still begins with the whole old
// name. Anything else is the user's edit and is sent as typed — deleting the
// repeated day word from "Standup today today 09:00" really renames the task,
// and a title holding "!1" or "#42" was never a filler problem.
function parseEdit(text, wasTitled) {
  var parsed = parseQuickAdd(text)
  var before = wasTitled === undefined || wasTitled === null
    ? "" : String(wasTitled).replace(/\s+/g, " ").trim()
  if (before === "" || parsed.title === before) return parsed
  var line = String(text || "").replace(/\s+/g, " ").trim()
  if (before.indexOf(parsed.title) === 0
      && TITLE_FILLER_TAIL.test(before.slice(parsed.title.length))
      && line.indexOf(before + " ") === 0) parsed.title = before
  return parsed
}

function editArgs(taskId, text, wasTitled) {
  var parsed = parseEdit(text, wasTitled)
  if (parsed.title === "") return null
  var args = [
    "update", String(taskId),
    "--title", parsed.title,
    "--priority", String(parsed.priority),
    "--tags", parsed.tags.join(",")
  ]
  if (parsed.dueGiven) args = args.concat(["--due", parsed.due])
  if (parsed.time) args = args.concat(["--time", parsed.time])
  return args
}

// `context` is where the line was typed: `defaultDue` is the day a line
// with no date of its own lands on ("" for undated, as a list view adds),
// and `projectId` files it in that list rather than the Inbox.
function quickAddArgs(text, context) {
  var parsed = parseQuickAdd(text)
  if (parsed.title === "") return null
  var ctx = context || {}
  var due = parsed.due
  if (!parsed.dueGiven && ctx.defaultDue !== undefined && ctx.defaultDue !== null) {
    // A clock needs a day to hang on; with no day of its own and none from
    // the view, today is the only honest reading of "9pm".
    due = ctx.defaultDue !== "" ? ctx.defaultDue : (parsed.time ? "today" : "")
  }
  var args = ["add", parsed.title]
  if (due !== "") args = args.concat(["--due", due])
  if (ctx.projectId) args = args.concat(["--project", String(ctx.projectId)])
  if (parsed.time) args = args.concat(["--time", parsed.time])
  if (parsed.priority > 0) args = args.concat(["--priority", String(parsed.priority)])
  if (parsed.tags.length > 0) args = args.concat(["--tags", parsed.tags.join(",")])
  return args
}

// ---- task actions -------------------------------------------------------
//
// The row menu's writes, as CLI argument lists. A reschedule keeps the
// task's time of day, the way TickTick's own date menu does.

var RESCHEDULE_CHOICES = [
  { key: "today", label: "Today", due: "today" },
  { key: "tomorrow", label: "Tomorrow", due: "tomorrow" },
  { key: "week", label: "+7 days", due: "+7" },
  { key: "none", label: "No date", due: "none" }
]

var PRIORITY_CHOICES = [
  { label: "None", value: 0 },
  { label: "Low", value: 1 },
  { label: "Med", value: 3 },
  { label: "High", value: 5 }
]

function rescheduleChoices() { return RESCHEDULE_CHOICES }
function priorityChoices() { return PRIORITY_CHOICES }

function rescheduleArgs(taskId, due) {
  if (!taskId || !due) return null
  var args = ["update", String(taskId), "--due", String(due)]
  if (due !== "none") args.push("--keep-time")
  return args
}

function priorityArgs(taskId, value) {
  if (!taskId) return null
  return ["update", String(taskId), "--priority", String(Number(value) || 0)]
}

function moveArgs(taskId, projectId) {
  if (!taskId || !projectId) return null
  return ["update", String(taskId), "--project", String(projectId)]
}

// The "Pick date…" line: parsed with the quick-add date grammar, so
// "friday", "2026-10-02", "tomorrow 9am" all work. Null when the line names
// no day, so a stray enter does not clear the date.
function pickDateArgs(taskId, text) {
  if (!taskId) return null
  var parsed = parseQuickAdd("x " + String(text || ""))
  if (!parsed.dueGiven) return null
  var args = ["update", String(taskId), "--due", parsed.due]
  if (parsed.time) args = args.concat(["--time", parsed.time])
  else args.push("--keep-time")
  return args
}

// ---- range offer ----------------------------------------------------------

// "gym 6 - 7am" is a range to whoever typed it, and a title ending in "6 -" to
// the grammar, which only reads a range when both ends are clocks. It cannot
// just start guessing: "Level 3 - 9pm" has the same shape and means exactly
// what the grammar reads, and every guess that reads it as a range is a
// reminder that worked yesterday landing at the wrong time today. So the field
// does not guess. The hint offers the range reading, and shift+enter takes it
// by rewriting the line into a spelling the grammar reads one way only
// ("gym 6am-7am"). Plain enter is unchanged.
var RANGE_TAIL = /(^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(\s*[-–—]\s*|\s+(?:to|til|till|until|thru|through)\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i

// Longest block worth offering. A workday ("shift 9 - 5pm") fits; eighteen
// hours ("Level 3 - 21:00") is not a range anyone meant.
var RANGE_OFFER_MAX_MINUTES = 8 * 60

// Tags and priority may trail the range ("gym 6 - 7am #fit !1"). Quick add
// strips them from anywhere, so the range is looked for in front of them and
// they go back after it.
var TRAILING_MARKS = /(?:\s+(?:#[^\s#]+|![A-Za-z0-9]+))+\s*$/

function offerClockMinutes(hour, minute, meridiem) {
  var h = Number(hour)
  var m = minute === undefined || minute === "" ? 0 : Number(minute)
  if (isNaN(h) || isNaN(m) || m > 59) return null
  if (meridiem) {
    if (h < 1 || h > 12) return null
    h = h % 12
    if (meridiem === "pm") h += 12
  } else if (h > 23) {
    return null
  }
  return h * 60 + m
}

function offerClockSpelled(total, withMeridiem) {
  var h = Math.floor(total / 60)
  var m = total % 60
  if (!withMeridiem) return pad2(h) + ":" + pad2(m)
  return (h % 12 === 0 ? 12 : h % 12) + (m ? ":" + pad2(m) : "") + (h >= 12 ? "pm" : "am")
}

// What shift+enter would turn the line into — { line, time, due, title } — or
// null when the line does not end in half a range, or already reads as the
// range it would get.
function halfRangeOffer(text) {
  var line = String(text || "")
  var marks = line.match(TRAILING_MARKS)
  var core = marks ? line.slice(0, marks.index) : line
  var suffix = marks ? marks[0].replace(/\s+$/, "") : ""
  var tail = core.match(RANGE_TAIL)
  if (!tail) return null
  var startMeridiem = tail[4] ? tail[4].toLowerCase() : ""
  var endMeridiem = tail[8] ? tail[8].toLowerCase() : ""
  // The end has to be a clock on its own; "gym 6 - 7" is two numbers.
  if (!endMeridiem && tail[7] === undefined) return null
  var end = offerClockMinutes(tail[6], tail[7], endMeridiem)
  if (end === null) return null

  // A bare start takes the end's meridiem, or the other one across noon
  // ("11 - 1pm") — whichever makes a real block.
  var tries = startMeridiem ? [startMeridiem]
    : endMeridiem ? [endMeridiem, endMeridiem === "am" ? "pm" : "am"]
    : [""]
  var spelled = startMeridiem !== "" || endMeridiem !== ""
  var current = parseQuickAdd(line)
  for (var i = 0; i < tries.length; i++) {
    var start = offerClockMinutes(tail[2], tail[3], tries[i])
    if (start === null) continue
    // An end not after the start runs into the next day ("shift 11 - 7am"),
    // which is how the grammar reads the full spelling too.
    var length = end - start
    if (length <= 0) length += 24 * 60
    if (length > RANGE_OFFER_MAX_MINUTES) continue
    var time = offerClockSpelled(start, false) + "-" + offerClockSpelled(end, false)
    if (current.time === time) return null
    var rewritten = core.slice(0, tail.index + tail[1].length)
      + offerClockSpelled(start, spelled) + "-" + offerClockSpelled(end, spelled) + suffix
    // Only offer what the grammar will actually read back, name intact.
    var reread = parseQuickAdd(rewritten)
    if (reread.title !== "" && reread.time === time) {
      return { line: rewritten, time: time, due: reread.due, title: reread.title }
    }
  }
  return null
}

// What the line in the field is about to create, as one short line under it.
// The grammar is narrow on purpose — a clock it does not recognise stays in
// the title, and the task quietly lands at midnight — so the field says what
// it understood while there is still time to fix it.
//
// `editing` matters: an add always sends a due date, so an undated line lands
// today, while an edit sends one only when the line carries a date and leaves
// the task's own schedule alone otherwise.
//
// `wasTitled` is the task's current name when editing. The grammar can take a
// trailing word that belongs to the title — "Look at today" is a task called
// "Look" — and an edit that changed nothing then renames the task on the way
// out. There is no reading that keeps both, so the hint says which one it
// picked while the field is still open.
var DUE_WORD_LABELS = { today: "Today", tomorrow: "Tomorrow", yesterday: "Yesterday" }

function quickAddPreview(parsed, editing, wasTitled) {
  if (!parsed || parsed.title === "") return ""

  // Compared the way the line is read: whitespace is tidied on the way out, as
  // it always has been, and a change nobody can see is not worth calling a
  // rename — a warning that fires for nothing teaches people to ignore it.
  var before = wasTitled === undefined || wasTitled === null
    ? "" : String(wasTitled).replace(/\s+/g, " ").trim()
  var renamed = editing && before !== "" && before !== parsed.title
    ? "Renaming to “" + parsed.title + "”"
    : ""

  var when
  if (editing && !parsed.dueGiven) {
    when = "Date unchanged"
  } else {
    when = DUE_WORD_LABELS[parsed.due] || String(parsed.due)
    // The en dash a duration wears everywhere else in the panel.
    if (parsed.time) when += " · " + String(parsed.time).replace("-", "–")
    // A line that looks like it carries a clock and does not reads as a plain
    // day otherwise, which is the same thing the field says when you typed no
    // time at all — and the difference is a reminder that fires or never does.
    else if (parsed.timeRejected) when += " · time not recognised"
    // "Level 3 - 9pm" and "gym 6 - 7am" have the same shape, so both keep
    // their clock; the name the task is about to get is what tells them apart.
    if (!editing && parsed.time && HALF_RANGE.test(parsed.title)) when += " · called “" + parsed.title + "”"
  }

  return renamed === "" ? when : renamed + " · " + when
}

// The calendar day a due word lands on, as a stamp.
function dueWordStamp(word, now) {
  var today = startOfDay(now || new Date())
  var w = String(word || "today").toLowerCase()
  if (w === "today") return dateStamp(today)
  if (w === "tomorrow") return dateStamp(addDays(today, 1))
  if (w === "yesterday") return dateStamp(addDays(today, -1))
  var parts = w.split("-")
  if (parts.length === 3) {
    var day = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    if (!isNaN(day.getTime())) return dateStamp(day)
  }
  return null
}

// The second line under the field: what shift+enter would do instead, or ""
// when it has nothing to offer. It has a line of its own so the first — what
// plain enter will do, the receipt this field has always given — keeps all its
// room. It names the day when taking the range lands the task on another one,
// and, while editing, the name the task would come out with when that differs.
function quickAddOfferHint(offer, parsed, editing, wasTitled, now) {
  if (!offer) return ""
  var said = "⇧ enter → "
  // The day is named whenever taking the range lands the task on another day
  // than plain enter would — compared as calendar days, so "2026-09-13" on the
  // 13th is today — and always while editing a line with no date in it: plain
  // enter leaves the task's own date alone there, but a range needs a day and
  // sets one.
  var keepsOwnDate = editing && parsed && !parsed.dueGiven
  if (!parsed || keepsOwnDate || dueWordStamp(offer.due, now) !== dueWordStamp(parsed.due, now)) {
    said += (DUE_WORD_LABELS[offer.due] || String(offer.due)) + " "
  }
  said += String(offer.time).replace("-", "–")
  if (editing) {
    var before = wasTitled === undefined || wasTitled === null
      ? "" : String(wasTitled).replace(/\s+/g, " ").trim()
    var after = parseEdit(offer.line, wasTitled).title
    if (before !== "" && after !== before) said += " · renaming to “" + after + "”"
  }
  return said
}

// ---- due tiers ---------------------------------------------------------

// TickTick has no colour for "overdue" or "today" — every client paints that
// itself. Returning a tier instead of a colour keeps the decision in the
// panel, where the theme's palette lives.
function dueTier(task, now) {
  if (isOverdue(task, now)) return "overdue"
  var due = taskDueDate(task)
  if (!due) return "upcoming"
  return dateStamp(due) === dateStamp(now || new Date()) ? "today" : "upcoming"
}

// ---- due notifications -------------------------------------------------

// How far back a reminder still counts as news. A check is often the first
// one in a while — the shell restarts on every theme or config change, and a
// laptop suspends — so without a floor the first pass after a gap would
// announce the whole morning at once. Too tight a floor loses the reminder
// that fell in the gap instead, which is why this is an hour and not a
// minute.
var NOTIFY_CATCHUP_MINUTES = 60

// How many titles a batched notification lists before it starts counting.
var NOTIFY_BODY_LINES = 5

// What "already announced" is keyed on. Not the id: a recurring task keeps
// its id and rolls its due date forward on completion, so an id alone would
// announce a daily task once and never again. Rescheduling earns a fresh
// reminder for the same reason — the moment is what was announced, not the
// row.
function notifyKey(task) {
  var when = taskTimeKey(task)
  if (!task || !task.id || !when) return ""
  return String(task.id) + "@" + when.getTime()
}

// Which tasks have just come due, and the announced-keys map to keep.
//
// The whole state transition lives here rather than in the service, so what
// is announced once and only once is testable without a shell: the caller
// spawns a process and saves `notified` back, and has no decisions of its
// own to get wrong.
//
// `options` carries `leadMinutes` (announce this far ahead of the moment),
// `catchupMinutes` (overridable for tests), `skipIds` — the completions held
// in the undo window, whose rows are already gone from the panel while the
// cache catches up — and `adopt`.
//
// `adopt` records every moment that has already passed without saying a
// word. It is what the first pass does after the feature is switched on: the
// catch-up window exists for a gap in a feature that was running, and
// switching it on is not a gap — nothing was missed, because nothing was
// armed. A reminder whose lead time has started but whose moment is still
// ahead was not missed either; it is due now, and goes out as usual.
function dueNotifications(tasks, now, notified, options) {
  var opts = options || {}
  var nowMs = (now || new Date()).getTime()
  var leadMs = Math.max(0, Number(opts.leadMinutes) || 0) * 60000
  var catchupMs = Math.max(1, Number(opts.catchupMinutes) || NOTIFY_CATCHUP_MINUTES) * 60000
  var seen = notified || {}
  var skip = opts.skipIds || {}

  var due = []
  var keep = {}

  // An announced key survives on its own moment, not on its task still being
  // in this pass's list. Rebuilding `keep` purely from the tasks meant any
  // moment a task stopped qualifying for — completed on the phone and then
  // un-completed, or pushed back into the future by lowering the lead — was
  // forgotten, and the same moment announced itself a second time when the
  // task qualified again. The key carries the instant, so it can be aged out
  // without the task, which is what still bounds the map to the window.
  for (var old in seen) {
    if (!seen[old]) continue
    var at = Number(String(old).slice(String(old).lastIndexOf("@") + 1))
    if (!isNaN(at) && nowMs - at <= catchupMs) keep[old] = true
  }

  for (var i = 0; i < (tasks || []).length; i++) {
    var task = tasks[i]
    if (!isOpen(task)) continue

    // An all-day task's due "time" is midnight, which is not a moment
    // anyone wants to be woken by. Dated-not-timed work is what the bar
    // count is for.
    if (task.isAllDay) continue

    // A duration is announced when it begins, not when it ends: taskTimeKey
    // already answers "the instant this happens", so a meeting 8:30-9:30
    // arrives at 8:30 rather than as it finishes.
    var when = taskTimeKey(task)
    if (!when) continue

    var fireMs = when.getTime() - leadMs
    if (fireMs > nowMs) continue

    // Too old to be news, and deliberately not recorded: the clock only
    // moves forward, so this can never come back around and claim a slot in
    // the map. That is also what bounds the map — everything in it fired
    // within the catch-up window, and falls out on the pass after.
    //
    // Measured from the moment, not from the lead-adjusted fire time. Against
    // `fireMs` the window would be `[due - lead, due - lead + catchup]`, which
    // closes before the task is even due once the lead reaches an hour: with
    // the 120 minutes the settings offer, a 17:00 meeting could only ever be
    // announced between 15:00 and 16:00, and a shell restarted at 16:10 would
    // never mention it at all.
    if (nowMs - when.getTime() > catchupMs) continue

    var key = notifyKey(task)
    if (key === "") continue

    // Already announced. Nothing to carry forward here — the loop above kept
    // it on the strength of its own moment, which is the one place retention
    // is decided.
    if (seen[key]) continue
    if (skip[String(task.id)]) continue

    keep[key] = true
    if (opts.adopt && when.getTime() <= nowMs) continue
    due.push(task)
  }

  due.sort(function(a, b) {
    var aKey = taskTimeKey(a)
    var bKey = taskTimeKey(b)
    return (aKey ? aKey.getTime() : 0) - (bKey ? bKey.getTime() : 0)
  })

  return { due: due, notified: keep }
}

// One line of a title, whatever the account sent. A batched body is a
// newline-joined list of "HH:MM  Title", and Omarchy's own notification card
// turns every newline into a line break — so a title carrying one forges an
// extra row that reads like a task of your own, and pushes a real reminder
// past the card's line cap. Collapsed before eliding, so the character budget
// is spent on the title rather than on whitespace.
function notifyTitle(task, limit) {
  return plainText(elide(String((task && task.title) || "Task").replace(/\s+/g, " "), limit))
}

// The argv for notify-send, or null when there is nothing to say.
//
// One notification per batch, not one per task: several tasks cross the line
// together often enough — at startup, on resume, on the hour — and five
// stacked popups for five o'clock is the failure mode this shape avoids.
function notifyArgs(due, now) {
  if (!due || due.length === 0) return null

  var summary
  var body
  if (due.length === 1) {
    summary = notifyTitle(due[0], 60)
    body = "Due " + dueLabel(due[0], now)
  } else {
    summary = due.length + " tasks due"
    var lines = []
    for (var i = 0; i < due.length && i < NOTIFY_BODY_LINES; i++) {
      lines.push(dueLabel(due[i], now) + "  " + notifyTitle(due[i], 48))
    }
    if (due.length > NOTIFY_BODY_LINES) lines.push("+" + (due.length - NOTIFY_BODY_LINES) + " more")
    body = lines.join("\n")
  }

  // "--" because a title someone began with a dash is a title, not an
  // option. plainText for the same reason the bar label uses it: the summary
  // is server-provided text headed for a notification daemon that renders
  // markup.
  return ["-a", "TickTick", "-u", "normal", "--", summary, body]
}

// The announced-keys file, read back the way parseCache reads its own: small,
// but still a file on disk that a full filesystem could have truncated.
function parseNotified(text) {
  if (!text) return {}
  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object" || parsed instanceof Array) return {}
    var out = {}
    for (var key in parsed) if (parsed[key]) out[key] = true
    return out
  } catch (e) {
    return {}
  }
}

// ---- habits ------------------------------------------------------------

function checkinFor(checkins, habitId, stamp) {
  var entries = (checkins && checkins[habitId]) || []
  for (var i = 0; i < entries.length; i++) {
    if (Number(entries[i].checkinStamp) === Number(stamp)) return entries[i]
  }
  return null
}

function habitProgress(habit, checkins, stamp) {
  var goal = Number((habit && habit.goal) || 1) || 1
  var entry = checkinFor(checkins, habit ? habit.id : "", stamp)
  var value = entry ? Number(entry.value || 0) : 0
  var status = entry ? Number(entry.status || 0) : 0
  return {
    value: value,
    goal: goal,
    ratio: goal > 0 ? Math.min(1, value / goal) : 0,
    done: status === CHECKIN_DONE || value >= goal,
    quantified: String(habit && habit.type) === "Real"
  }
}

// Consecutive completed days ending today, or ending yesterday when today
// is still open — a streak shouldn't read as broken at 9am.
function habitStreak(checkins, habitId, todayStamp) {
  var entries = (checkins && checkins[habitId]) || []
  var done = {}
  for (var i = 0; i < entries.length; i++) {
    if (Number(entries[i].status) === CHECKIN_DONE) done[Number(entries[i].checkinStamp)] = true
  }

  var cursor = stampToDate(todayStamp)
  if (!cursor) return 0
  if (!done[Number(todayStamp)]) cursor = addDays(cursor, -1)

  var streak = 0
  while (done[dateStamp(cursor)]) {
    streak++
    cursor = addDays(cursor, -1)
  }
  return streak
}

function habitLabel(habit, progress) {
  if (!progress.quantified) return habit.name
  var unit = habit.unit ? " " + habit.unit : ""
  return habit.name + "  " + trimNumber(progress.value) + "/" + trimNumber(progress.goal) + unit
}

function trimNumber(value) {
  var number = Number(value || 0)
  return number % 1 === 0 ? String(number) : number.toFixed(1)
}

function habitsRemaining(habits, checkins, stamp) {
  var count = 0
  for (var i = 0; i < (habits || []).length; i++) {
    if (!habitProgress(habits[i], checkins, stamp).done) count++
  }
  return count
}

// ---- bar label ---------------------------------------------------------

var BAR_LABEL_MODES = ["Count", "Next", "Icon"]

function cycleBarLabel(current) {
  var i = BAR_LABEL_MODES.indexOf(String(current))
  if (i < 0) i = 0
  return BAR_LABEL_MODES[(i + 1) % BAR_LABEL_MODES.length]
}

function barLabelDescription(mode) {
  if (mode === "Next") return "next task"
  if (mode === "Icon") return "icon only"
  return "counts"
}

function barLabel(mode, tasks, habitsLeft, now) {
  if (mode === "Icon") return ""

  if (mode === "Next") {
    var next = nextTask(tasks)
    if (!next) return habitsLeft > 0 ? habitsLeft + " habits" : ""
    // This string ends up in the shell's own Text items (WidgetButton,
    // OpticalGlyph), which default to AutoText — sanitized, not just elided.
    return elide(plainText(next.title), 28)
  }

  var parts = []
  if (tasks && tasks.length > 0) parts.push(String(tasks.length))
  if (habitsLeft > 0) parts.push(habitsLeft + "♦")
  return parts.join("  ")
}

function elide(text, limit) {
  if (text.length <= limit) return text
  return text.slice(0, Math.max(1, limit - 1)) + "…"
}

// For remote strings headed into Text items outside this plugin, where
// textFormat cannot be pinned to PlainText. Qt's AutoText heuristic keys on
// angle brackets, so swapping them for lookalikes keeps a title readable
// while making it inert.
function plainText(text) {
  return String(text || "").replace(/</g, "‹").replace(/>/g, "›")
}

function overdueCount(tasks, now) {
  var count = 0
  for (var i = 0; i < (tasks || []).length; i++) {
    if (isOverdue(tasks[i], now)) count++
  }
  return count
}

// ---- pomodoro ----------------------------------------------------------

function formatClock(seconds) {
  var total = Math.max(0, Math.round(seconds))
  var mins = Math.floor(total / 60)
  var secs = total % 60
  if (mins >= 60) {
    var hours = Math.floor(mins / 60)
    return hours + ":" + pad2(mins % 60) + ":" + pad2(secs)
  }
  return pad2(mins) + ":" + pad2(secs)
}

// TickTick's own cycle: focus, short break, focus, ... and a long break
// every `longBreakInterval` focus blocks. Mirroring it means a session
// logged here lands in the same rhythm the phone app would have used.
function pomoPhaseAfter(completedFocusBlocks, prefs) {
  var settings = prefs || {}
  var interval = Math.max(1, Number(settings.longBreakInterval || 4))
  var done = Math.max(0, Number(completedFocusBlocks || 0))
  return (done > 0 && done % interval === 0) ? "longBreak" : "shortBreak"
}

// Account settings are the default; a non-zero plugin setting wins. Zero
// means "whatever TickTick says", so the panel follows the phone app until
// the user deliberately disagrees with it.
function mergePomoPrefs(prefs, overrides) {
  var base = prefs || {}
  var over = overrides || {}

  function pick(overrideValue, baseValue, fallback) {
    var chosen = Number(overrideValue || 0)
    if (chosen > 0) return chosen
    var inherited = Number(baseValue || 0)
    return inherited > 0 ? inherited : fallback
  }

  return {
    pomoDuration: pick(over.pomoMinutes, base.pomoDuration, 25),
    shortBreakDuration: pick(over.shortBreakMinutes, base.shortBreakDuration, 5),
    longBreakDuration: pick(over.longBreakMinutes, base.longBreakDuration, 15),
    longBreakInterval: pick(over.longBreakInterval, base.longBreakInterval, 4),
    pomoGoal: Number(base.pomoGoal || 0)
  }
}

function pomoPhaseSeconds(phase, prefs) {
  var settings = prefs || {}
  if (phase === "shortBreak") return Math.max(1, Number(settings.shortBreakDuration || 5)) * 60
  if (phase === "longBreak") return Math.max(1, Number(settings.longBreakDuration || 15)) * 60
  return Math.max(1, Number(settings.pomoDuration || 25)) * 60
}

function pomoPhaseLabel(phase) {
  if (phase === "shortBreak") return "Short break"
  if (phase === "longBreak") return "Long break"
  return "Focus"
}

function pomoTodayLabel(stats, prefs) {
  var count = Number((stats || {}).todayPomoCount || 0)
  var goal = Number((prefs || {}).pomoGoal || 0)
  var minutes = Number((stats || {}).todayPomoDuration || 0)
  var head = goal > 0 ? count + "/" + goal + " today" : count + " today"
  return minutes > 0 ? head + " · " + minutes + "m" : head
}

// ---- undo --------------------------------------------------------------

// Actions are held, not sent and then reversed. Completing a recurring task
// rolls it to its next occurrence, and reopening afterwards does not put
// that back — so the only honest undo is one that happens before the
// request leaves.
function undoSecondsLeft(deadlineMs, nowMs) {
  if (!deadlineMs) return 0
  return Math.max(0, Math.ceil((deadlineMs - (nowMs || Date.now())) / 1000))
}

// Held actions are a stack, not a single slot. Ticking four things off in a
// row is the normal way a list gets cleared, and holding only the newest
// meant the previous three were already gone by the time anyone noticed the
// mistake — the undo window failed exactly where mistakes cluster.
//
// Splitting the due ones from the rest is pure list work, so it lives here
// where it can be tested rather than inside a timer.
function expirePending(list, nowMs) {
  var now = nowMs || Date.now()
  var due = []
  var remaining = []
  for (var i = 0; i < (list || []).length; i++) {
    var entry = list[i]
    if (entry && entry.deadline <= now) due.push(entry)
    else remaining.push(entry)
  }
  return { due: due, remaining: remaining }
}

// What `u` would undo: the most recent, since that is the one just done.
function topPending(list) {
  return (list && list.length > 0) ? list[list.length - 1] : null
}

function dropTopPending(list) {
  return (list && list.length > 0) ? list.slice(0, list.length - 1) : []
}

// The countdown is rendered separately, so this is only the sentence part.
function undoLabel(pending, secondsLeft) {
  if (!pending) return ""
  var name = elide(String(pending.title || ""), 26)
  var verb = pending.kind === "checkin" ? "Checked in" : "Completed"
  return verb + " " + name
}

// Says how much is waiting behind the one being offered for undo, so a stack
// of held actions is never invisible.
function heldSuffix(count) {
  return count > 1 ? "  +" + (count - 1) + " more" : ""
}

// ---- cache -------------------------------------------------------------

function parseCache(text) {
  var empty = {
    syncedAt: 0,
    inboxId: "",
    projects: [],
    projectGroups: [],
    tasks: [],
    habits: [],
    checkins: {},
    todayStamp: 0,
    queued: 0,
    tags: [],
    pomoStats: {},
    pomoPrefs: {},
    authRequired: false,
    error: null
  }
  if (!text) return empty
  try {
    var parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== "object") return empty
    return {
      syncedAt: Number(parsed.syncedAt || 0),
      inboxId: String(parsed.inboxId || ""),
      projects: parsed.projects || [],
      projectGroups: parsed.projectGroups || [],
      tasks: parsed.tasks || [],
      habits: parsed.habits || [],
      checkins: parsed.checkins || {},
      todayStamp: Number(parsed.todayStamp || 0),
      queued: Number(parsed.queued || 0),
      tags: parsed.tags || [],
      pomoStats: parsed.pomoStats || {},
      pomoPrefs: parsed.pomoPrefs || {},
      authRequired: !!parsed.authRequired,
      error: parsed.error || null
    }
  } catch (e) {
    return empty
  }
}

function staleMinutes(syncedAt, now) {
  if (!syncedAt) return -1
  return Math.floor(((now || Date.now()) - syncedAt) / 60000)
}

// QML imports this file directly; node needs the same functions as a module
// so the logic above can be tested without a shell.
if (typeof module !== "undefined") {
  module.exports = {
    parseApiDate: parseApiDate,
    taskDueDate: taskDueDate,
    taskStartDate: taskStartDate,
    taskTimeKey: taskTimeKey,
    startOfDay: startOfDay,
    endOfDay: endOfDay,
    addDays: addDays,
    dateStamp: dateStamp,
    stampToDate: stampToDate,
    horizonDays: horizonDays,
    quickViews: quickViews,
    viewKind: viewKind,
    viewRef: viewRef,
    isDateView: isDateView,
    normalizeView: normalizeView,
    resolveView: resolveView,
    viewTitle: viewTitle,
    cycleView: cycleView,
    viewForDue: viewForDue,
    widerView: widerView,
    defaultDueForView: defaultDueForView,
    viewTasks: viewTasks,
    sortTasks: sortTasks,
    groupTasks: groupTasks,
    dateBucket: dateBucket,
    statusCounts: statusCounts,
    statusDots: statusDots,
    statusSummary: statusSummary,
    viewOrder: viewOrder,
    cycleSort: cycleSort,
    cycleGroup: cycleGroup,
    cyclePriorityFilter: cyclePriorityFilter,
    priorityFilterLabel: priorityFilterLabel,
    cycleTagFilter: cycleTagFilter,
    isRecurringTask: isRecurringTask,
    isOpen: isOpen,
    isOverdue: isOverdue,
    dueTasks: dueTasks,
    nextTask: nextTask,
    nextTaskTitle: nextTaskTitle,
    dueLabel: dueLabel,
    priorityRank: priorityRank,
    tagIndex: tagIndex,
    firstTag: firstTag,
    tagColor: tagColor,
    tagLabel: tagLabel,
    dueTier: dueTier,
    notifyKey: notifyKey,
    dueNotifications: dueNotifications,
    notifyArgs: notifyArgs,
    parseNotified: parseNotified,
    syncIntervalSeconds: syncIntervalSeconds,
    syncIntervalLabels: syncIntervalLabels,
    parseQuickAdd: parseQuickAdd,
    quickAddArgs: quickAddArgs,
    rescheduleChoices: rescheduleChoices,
    priorityChoices: priorityChoices,
    rescheduleArgs: rescheduleArgs,
    priorityArgs: priorityArgs,
    moveArgs: moveArgs,
    pickDateArgs: pickDateArgs,
    quickAddPreview: quickAddPreview,
    editLineFor: editLineFor,
    editArgs: editArgs,
    parseEdit: parseEdit,
    halfRangeOffer: halfRangeOffer,
    quickAddOfferHint: quickAddOfferHint,
    projectName: projectName,
    checkinFor: checkinFor,
    habitProgress: habitProgress,
    habitStreak: habitStreak,
    habitLabel: habitLabel,
    habitsRemaining: habitsRemaining,
    barLabel: barLabel,
    plainText: plainText,
    hasDetails: hasDetails,
    subtasks: subtasks,
    taskMarkdown: taskMarkdown,
    cycleBarLabel: cycleBarLabel,
    barLabelDescription: barLabelDescription,
    elide: elide,
    overdueCount: overdueCount,
    formatClock: formatClock,
    pomoPhaseAfter: pomoPhaseAfter,
    mergePomoPrefs: mergePomoPrefs,
    pomoPhaseSeconds: pomoPhaseSeconds,
    pomoPhaseLabel: pomoPhaseLabel,
    pomoTodayLabel: pomoTodayLabel,
    undoSecondsLeft: undoSecondsLeft,
    expirePending: expirePending,
    topPending: topPending,
    dropTopPending: dropTopPending,
    heldSuffix: heldSuffix,
    undoLabel: undoLabel,
    parseCache: parseCache,
    staleMinutes: staleMinutes
  }
}
