import QtQuick
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Bar slot for TickTick. The service owns the cache, the sync timer, and the
// CLI; this reads the already-shaped state off the panel so it stays live
// whether or not the popup has ever been opened.
//
// State is three dots down the left side of the checklist glyph rather than
// a colour change or a number: red at the top for overdue, blue in the
// middle for due today, green at the bottom for due in the next seven days.
// Each is on or off, so the icon reads at a glance and never changes width.
BarWidget {
  id: root
  moduleName: "design-nexus.ticktick"

  // nf-fa-tasks. A checklist reads as "things to do" at bar size in a way
  // a check mark does not — a check mark reads as "done".
  //
  // Written as an escape, not as the literal glyph: a raw private-use-area
  // character does not survive every editor and tool that touches this file,
  // and when it is silently dropped the widget renders a bare number.
  readonly property string icon: ""

  readonly property var service: bar && bar.shell && typeof bar.shell.serviceFor === "function"
    ? bar.shell.serviceFor("design-nexus.ticktick")
    : null

  readonly property string panelLabel: panelLoader.item ? panelLoader.item.label : ""
  readonly property var dots: panelLoader.item && panelLoader.item.dots
    ? panelLoader.item.dots : ({ overdue: false, today: false, week: false })
  readonly property string statusSummary: panelLoader.item ? panelLoader.item.statusSummary : ""

  // Fixed hues, overridable per entry: the theme has no red, blue or green
  // roles, only accent and urgent, and three dots in one accent colour would
  // say nothing about which is which.
  readonly property color overdueDotColor: setting("dotOverdueColor", "#e0443e")
  readonly property color todayDotColor: setting("dotTodayColor", "#3b82f6")
  readonly property color weekDotColor: setting("dotWeekColor", "#22c55e")
  readonly property bool showDots: signedIn
  readonly property bool signedIn: panelLoader.item ? panelLoader.item.signedIn : false

  // A live countdown outranks the task count: while a block is running,
  // the remaining time is the only thing on the bar worth the space.
  readonly property string pomoClock: panelLoader.item ? panelLoader.item.pomoClock : ""
  readonly property bool pomoRunning: panelLoader.item ? panelLoader.item.pomoRunning === true : false
  readonly property bool pomoPaused: panelLoader.item ? panelLoader.item.pomoPaused === true : false
  readonly property bool pomoActive: pomoRunning || pomoPaused

  // An unconnected plugin gets its own glyph rather than a dimmed checklist:
  // a faint "0 tasks" reads as "nothing to do", which is the opposite of
  // "needs setup". A plug says which one it is at a glance.
  readonly property string setupIcon: ""

  readonly property string activeIcon: !signedIn
    ? setupIcon
    : (pomoActive ? "" : icon)
  readonly property string activeLabel: !signedIn
    ? "setup"
    : (pomoActive ? pomoClock : panelLabel)

  // In "Next" mode the label is a task title, which is as long as someone
  // felt like typing. The bar scrolls it rather than cutting it off, the same
  // way the first-party media widget scrolls a track name — and, like that
  // widget, only in the bar. The panel's rows still elide, because seven
  // scrolling lines cannot be scanned.
  readonly property string barLabelMode: setting("barLabel", "Icon")
  readonly property string nextTitle: panelLoader.item ? panelLoader.item.nextTitle : ""
  readonly property bool marquee: !vertical && !pomoActive && signedIn
    && barLabelMode === "Next" && nextTitle !== ""
  readonly property real marqueeWidth: Style.space(150)

  readonly property string displayText: activeLabel === "" ? activeIcon : activeIcon + "  " + activeLabel
  readonly property var verticalLines: activeLabel === "" ? [activeIcon] : [activeIcon, activeLabel]

  // Right-click cycles what the bar shows, which is how the built-in clock and
  // the calendar plugin let you change their label. Writing it back through
  // the shell means the choice survives a restart instead of being a mode you
  // have to re-pick every session.
  function cycleBarLabel() {
    var next = Model.cycleBarLabel(barLabelMode)
    var entry = { id: root.moduleName }
    for (var key in root.settings) if (key !== "id") entry[key] = root.settings[key]
    entry.barLabel = next

    // Applied locally first so the bar changes on the click itself; the
    // persisted write comes back through the bar as the same value.
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Shape contract for shell.summon/hide/toggle routing: Bar.findPanelWidget
  // requires open/close/opened on the bar-widget root.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity, the same way the first-party panel widgets do.
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // An IPC target routes to exactly one handler, but this widget is live once
  // per monitor, so the instance that claimed the target is rarely the one you
  // are looking at. The bar already resolves this for `shell.summon` by asking
  // Hyprland which output is focused; these calls borrow the same resolution
  // instead of acting locally and opening a panel on the other screen.
  function focusedInstance() {
    if (root.bar && typeof root.bar.findPanelWidget === "function") {
      var item = root.bar.findPanelWidget(root.moduleName)
      if (item) return item
    }
    return root
  }

  IpcHandler {
    target: "design-nexus.ticktick"

    // Refresh is not a place, so it goes to every instance.
    function sync(): void { root.broadcast("refresh") }

    // Same switch as the right-click, for a keybinding. Routed to the focused
    // instance so the write happens once rather than once per monitor.
    function cycleLabel(): void { root.focusedInstance().cycleBarLabel() }

    // The focus clock lives in the service, so these are not per-monitor and
    // need no routing. Bindable: `omarchy-shell <id> focus` starts or pauses
    // a block without opening anything.
    function focus(): void { if (root.service) root.service.togglePomo() }
    function focusStop(): void { if (root.service) root.service.stopPomo() }

    function open(): void { root.focusedInstance().open() }
    function close(): void { root.focusedInstance().close() }
    function show(): void { root.focusedInstance().open() }
    function hide(): void { root.focusedInstance().close() }
    function toggle(): void { root.focusedInstance().togglePanel() }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: (root.vertical || root.marquee) ? "" : root.displayText
    fixedWidth: root.marquee ? root.marqueeWidth + Style.space(30) : -1
    // Room on the left for the dot rail, so a dot is never clipped by the
    // neighbouring module.
    horizontalMargin: 11
    labelVisible: !root.vertical
    // The marquee draws its own children, so the slot has content even though
    // the button's own text is empty. Without this the bar treats it as blank
    // and the widget disappears.
    hasVisualContent: root.marquee
      ? true
      : (root.vertical ? root.verticalLines.length > 0 : text !== "")
    fixedHeight: root.vertical ? root.verticalLines.length * Style.bar.iconSlot : -1

    // The dots carry task state, so the glyph keeps the bar's own colour.
    // Only a running focus block claims the urgent colour.
    active: root.pomoActive ? root.pomoRunning : false
    // A disconnected plugin should look inert rather than like zero work.
    dimmed: !root.signedIn

    tooltipText: root.signedIn
      ? "TickTick — " + root.statusSummary
        + "\nright click for " + Model.barLabelDescription(Model.cycleBarLabel(root.barLabelMode))
      : "TickTick — click to connect"

    onPressed: function(b) {
      if (b === Qt.MiddleButton) root.refresh()
      // Opening the web app moved into the panel's "Open in TickTick" row,
      // which frees the bar's right-click for the thing you would actually
      // want to change from the bar.
      else if (b === Qt.RightButton) root.cycleBarLabel()
      else root.togglePanel()
    }

    // ---- status dots ------------------------------------------------------
    //
    // A rail as tall as the glyph, just left of it: top, middle, bottom. The
    // label is centred in the slot, so the glyph's left edge is where the
    // centred label begins; in the marquee the glyph is the Row's first child;
    // on a vertical bar it is the first cell of the column.
    Item {
      id: dotRail
      visible: root.showDots
      readonly property real dot: Math.max(2.5, button.fontSize * 0.21)
      readonly property real glyphLeft: root.vertical
        ? (button.width - button.fontSize) / 2
        : (root.marquee
          ? marqueeRow.x
          : (button.width - button.labelWidth) / 2)
      readonly property real glyphCenterY: root.vertical ? Style.bar.iconSlot / 2 : button.height / 2

      width: dot
      height: Math.round(button.fontSize * 0.95)
      x: Math.round(glyphLeft - width - Math.max(1, dot * 0.4))
      y: Math.round(glyphCenterY - height / 2)

      Rectangle {
        visible: root.dots.overdue
        anchors.top: parent.top
        width: dotRail.dot; height: width; radius: width / 2
        color: root.overdueDotColor
      }
      Rectangle {
        visible: root.dots.today
        anchors.verticalCenter: parent.verticalCenter
        width: dotRail.dot; height: width; radius: width / 2
        color: root.todayDotColor
      }
      Rectangle {
        visible: root.dots.week
        anchors.bottom: parent.bottom
        width: dotRail.dot; height: width; radius: width / 2
        color: root.weekDotColor
      }
    }

    // Scrolling label. Held to one clip so the glyph stays put and only the
    // title moves.
    Row {
      id: marqueeRow
      visible: root.marquee
      anchors.centerIn: parent
      spacing: Style.space(8)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        text: root.activeIcon
        color: button.foreground
        font.family: button.fontFamily
        font.pixelSize: button.fontSize
      }

      Item {
        id: scrollClip
        width: Math.min(root.marqueeWidth, marqueeText.implicitWidth)
        height: button.height
        clip: true
        anchors.verticalCenter: parent.verticalCenter

        Text {
          id: marqueeText
          text: root.nextTitle
          // Task titles are remote; AutoText would render HTML-shaped ones.
          textFormat: Text.PlainText
          color: button.foreground
          font.family: button.fontFamily
          font.pixelSize: button.fontSize
          anchors.verticalCenter: parent.verticalCenter

          readonly property bool needsScroll: implicitWidth > scrollClip.width

          // Scroll to the end, wait, come back — the same motion the panel
          // rows use. A continuous wrap, as the media widget does it, sends
          // the title off one edge and back in the other, which leaves the
          // bar slot looking empty for part of every loop. A track name can
          // afford that; a task you are being reminded of cannot.
          onNeedsScrollChanged: if (!needsScroll) x = 0

          SequentialAnimation on x {
            running: marqueeText.needsScroll && !root.opened
            loops: Animation.Infinite

            PauseAnimation { duration: 2000 }
            NumberAnimation {
              from: 0
              to: Math.min(0, scrollClip.width - marqueeText.implicitWidth)
              // Constant reading speed: a longer title takes longer rather
              // than moving faster.
              duration: Math.max(900, (marqueeText.implicitWidth - scrollClip.width) * 28)
              easing.type: Easing.Linear
            }
            PauseAnimation { duration: 1600 }
            NumberAnimation { to: 0; duration: 400; easing.type: Easing.OutCubic }
          }
        }
      }
    }

    Column {
      visible: root.vertical
      anchors.fill: parent

      Repeater {
        model: root.verticalLines

        OpticalGlyph {
          required property string modelData
          width: button.width
          height: Style.bar.iconSlot
          text: modelData
          fontFamily: button.fontFamily
          fontSize: modelData.length > 2 ? button.fontSize * 0.85 : button.fontSize
          color: button.foreground
        }
      }
    }
  }
}
