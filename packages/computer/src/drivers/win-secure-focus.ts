import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { Point, Rect, WindowInfo } from "../core/types.ts";
import { spawnScriptHelper } from "./win-script-helper.ts";

/*
 * Windows has no cheap way to ask "is the focused control a password field" from Node, and Cua
 * does not report it for free-form keys. UI Automation (shipped with Windows) does, but the
 * managed provider sees WinForms / Win32 edits as a Pane with IsPassword=false, so a
 * second, Win32 signal is required: the focused HWND's edit class plus ES_PASSWORD /
 * EM_GETPASSWORDCHAR. Either source saying "password" wins; a source that cannot see the
 * control says nothing.
 *
 * The answer must also name the top-level window the focus is in — the
 * same app's other window (a dialog, a second document) says nothing about the field we are
 * about to type into — and the probe must neither be cached (focus moves between the check and
 * the keystroke) nor pay Add-Type on every call. So one PowerShell process stays resident,
 * loads UI Automation and the Win32 entry points once, and answers one line per query.
 *
 * The same resident helper also selects a row through UI Automation's SelectionItem pattern
 *A second process would pay the same Add-Type startup again, and this one already
 * has UI Automation loaded and knows how to match the tree's frames against real rects.
 */

const QUERY_TIMEOUT_MS = 3000;
/** Add-Type compiles the Win32 shim on the first query; that is startup, not a slow answer. */
const STARTUP_TIMEOUT_MS = 10_000;

const SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr hWnd, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")]
  public static extern IntPtr ListItemRect(IntPtr hWnd, uint msg, IntPtr index, out RECT rect);
  public static bool ListClientPoint(IntPtr hWnd, ref POINT point) {
    // LB_ITEMFROMPOINT and LB_GETITEMRECT use the list's own units, even when our helper is
    // per-monitor aware and the list is bitmap-scaled. Both the screen point and ScreenToClient
    // must use the receiver's context; changing only the context still leaves a physical point.
    if (!PhysicalToLogicalPointForPerMonitorDPI(hWnd, ref point)) return false;
    IntPtr context = GetWindowDpiAwarenessContext(hWnd);
    if (context == IntPtr.Zero) return false;
    IntPtr previous = SetThreadDpiAwarenessContext(context);
    if (previous == IntPtr.Zero) return false;
    try { return ScreenToClient(hWnd, ref point); }
    finally { SetThreadDpiAwarenessContext(previous); }
  }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
# An element lookup compares rects from two readers: the tree's frames and this process's own
# Win32 / UI Automation reads. A DPI-unaware process gets virtualized Win32 coordinates while
# UI Automation stays physical, so the two would never line up; ask for the real pixels once.
try { $aware = [W]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { $aware = $false }
if (-not $aware) { [void][W]::SetProcessDPIAware() }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$rootHwnd = [System.Windows.Automation.AutomationElement]::RootElement.Current.NativeWindowHandle
$editClass = '^(Edit|RichEdit|RICHEDIT|WindowsForms10\\.(EDIT|RICHEDIT)|TEdit|TDBEdit)'
# The tree reports logical points while Win32 (GetWindowRect, WindowFromPoint) and UI Automation
# answer in physical pixels. On a 150% / 200% display the two never line up, so a point or a rect
# taken as-is from the tree lands in a different window and every element looks unprovable.
# Both queries below convert with the scale of the display the window is on.
#
# The display, not the window: a DPI-unaware window (most older Win32 apps) answers 96 to
# GetDpiForWindow however the screen is set up, because the system bitmap-stretches it. Cua's tree
# uses the display scale for both kinds of window, so a scale of 1 on a 200% screen made every rect
# comparison miss and every write look occluded. MDT_EFFECTIVE_DPI is the user's
# chosen scale, which is what the tree is expressed in.
function DpiScaleOf([IntPtr]$h) {
  $dpi = 0
  try {
    $monitor = [W]::MonitorFromWindow($h, 2)
    if ($monitor -ne [IntPtr]::Zero) {
      $mx = [uint32]0; $my = [uint32]0
      # shcore.dll is Windows 8.1+; on anything older the call throws and the fallback answers.
      if ([W]::GetDpiForMonitor($monitor, 0, [ref]$mx, [ref]$my) -eq 0) { $dpi = [int]$mx }
    }
  } catch { $dpi = 0 }
  if ($dpi -lt 48) { try { $dpi = [int][W]::GetDpiForWindow($h) } catch { $dpi = 0 } }
  if ($dpi -lt 48) { $dpi = 96 }
  return ([double]$dpi / 96.0)
}
# How close two rects are, as a score where 0 means "not this control". Edges may differ by a
# few pixels between two accessibility clients looking at the same control.
function EdgeScore($a, $b) {
  $d = [Math]::Max([Math]::Max([Math]::Abs($a[0] - $b[0]), [Math]::Abs($a[1] - $b[1])), [Math]::Max([Math]::Abs($a[2] - $b[2]), [Math]::Abs($a[3] - $b[3])))
  if ($d -le 6) { return 1000 - $d }
  $overlapW = [Math]::Min($a[2], $b[2]) - [Math]::Max($a[0], $b[0])
  $overlapH = [Math]::Min($a[3], $b[3]) - [Math]::Max($a[1], $b[1])
  if ($overlapW -le 0 -or $overlapH -le 0) { return 0 }
  $smaller = [Math]::Min(($a[2] - $a[0]) * ($a[3] - $a[1]), ($b[2] - $b[0]) * ($b[3] - $b[1]))
  if ($smaller -le 0) { return 0 }
  $ratio = ($overlapW * $overlapH) / $smaller
  if ($ratio -ge 0.85) { return [int]($ratio * 100) }
  return 0
}
function TopOf($el) {
  $top = $el
  for ($i = 0; $i -lt 64; $i++) {
    $parent = $walker.GetParent($top)
    if (-not $parent) { break }
    if ($parent.Current.NativeWindowHandle -eq $rootHwnd) { break }
    $top = $parent
  }
  return [int64]$top.Current.NativeWindowHandle
}
# Classic Win32 and WinForms lists keep their rows in a child window that the managed UI
# Automation client sees as a single Pane with no items, so a row there can never be selected
# through the SelectionItem pattern. Those controls are told about a row with their
# own window messages instead, which neither move the pointer nor change the foreground.
# The classes are the ones Win32, WinForms and Delphi give a single-column list.
# A list view (SysListView32) is deliberately left out: its LVM_* messages take a pointer to a
# LVHITTESTINFO / LVITEM, and Windows does not marshal those across processes — the target would
# read our process's address in its own memory, so a wrong message either does nothing or corrupts
# the user's app. Selecting a list-view row stays with the UI Automation SelectionItem path, and
# an element no route can select is refused with the existing press / keys hint.
$listClass = '^(listbox|windowsforms10..*listbox.*|tlistbox)$'
function SelectInList([IntPtr]$top, $cands) {
  # Only the display-scaled rect is authoritative for list hit testing. Trying raw/inverse
  # fallbacks can put the same element's centre on a different, otherwise valid row (Y1).
  $cands = ,$cands[0]
  # Every list child of the target window, with the rect Win32 reports for it.
  $lists = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($top)
  $visited = 0
  while ($stack.Count -gt 0 -and $visited -lt 2000) {
    $visited++
    $par = $stack.Pop()
    $child = [W]::FindWindowEx($par, [IntPtr]::Zero, [NullString]::Value, [NullString]::Value)
    while ($child -ne [IntPtr]::Zero) {
      $cb = New-Object System.Text.StringBuilder 256
      [void][W]::GetClassName($child, $cb, 256)
      $cls = $cb.ToString()
      $cr = [W+RECT]::new()
      if (($cls -match $listClass) -and [W]::GetWindowRect($child, [ref]$cr)) {
        $lists += ,@([int64]$child.ToInt64(), $cls, @($cr.left, $cr.top, $cr.right, $cr.bottom))
      }
      $stack.Push($child)
      $child = [W]::FindWindowEx($par, $child, [NullString]::Value, [NullString]::Value)
    }
  }
  if ($lists.Count -eq 0) { return 0 }
  foreach ($q in $cands) {
    # The row's rect lies inside the list's rect; the smallest list containing it is the one the
    # row belongs to (a nested list inside a list exists, e.g. a combo box in a list cell).
    $bestArea = [double]::MaxValue
    $hitList = $null
    foreach ($l in $lists) {
      $r = $l[2]
      if ($q[0] -lt $r[0] -or $q[1] -lt $r[1] -or $q[2] -gt $r[2] -or $q[3] -gt $r[3]) { continue }
      $area = ($r[2] - $r[0]) * ($r[3] - $r[1])
      if ($area -lt $bestArea) { $bestArea = $area; $hitList = $l }
    }
    if (-not $hitList) { continue }
    $h = [IntPtr][int64]$hitList[0]
    # The item index comes from where the row's centre lies inside the list's client area.
    $pt = [W+POINT]::new()
    $pt.x = [int][Math]::Round((($q[0] + $q[2]) / 2.0))
    $pt.y = [int][Math]::Round((($q[1] + $q[3]) / 2.0))
    if (-not [W]::ListClientPoint($h, [ref]$pt)) { continue }
    if ($pt.x -lt 0 -or $pt.y -lt 0 -or $pt.x -gt 32767 -or $pt.y -gt 32767) { continue }
    # LB_ITEMFROMPOINT: low word is the item, high word is 1 when the point is off the items.
    $lp = [IntPtr](($pt.y -shl 16) -bor ($pt.x -band 0xFFFF))
    $r = [int64][W]::SendMessage($h, 0x01A9, [IntPtr]::Zero, $lp).ToInt64()
    if ((($r -shr 16) -band 0xFFFF) -ne 0) { continue }
    $idx = [int]($r -band 0xFFFF)
    if ($idx -eq 0xFFFF) { continue }
    # LB_GETITEMRECT is a system message (< WM_USER), so Windows marshals its RECT across
    # processes, unlike the deliberately excluded LVM_* messages. A nearest-item hit alone
    # proves nothing: the intended point must actually be inside that row before changing it.
    $itemRect = [W+RECT]::new()
    if ([W]::ListItemRect($h, 0x0198, [IntPtr]$idx, [ref]$itemRect).ToInt64() -eq -1) { continue }
    if ($pt.x -lt $itemRect.left -or $pt.x -ge $itemRect.right -or $pt.y -lt $itemRect.top -or $pt.y -ge $itemRect.bottom) { continue }
    if ([int64][W]::SendMessage($h, 0x0186, [IntPtr]$idx, [IntPtr]::Zero).ToInt64() -eq -1) { continue }
    # The parent only learns about the new row from this notification, exactly as when the user
    # clicks it; without it a WinForms form keeps drawing the old SelectedIndex.
    $parent = [W]::GetParent($h)
    if ($parent -ne [IntPtr]::Zero) {
      $id = [W]::GetDlgCtrlID($h)
      $notify = [IntPtr]((1 -shl 16) -bor ($id -band 0xFFFF))
      [void][W]::SendMessage($parent, 0x0111, $notify, $h)
    }
    # The parent may change selection again. The request was already delivered: 2 prevents an
    # unsupported/no-delivery reply and prevents a second attempt through the UIA fallback.
    if ([W]::SendMessage($h, 0x0188, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64() -ne $idx) { return 2 }
    return 1
  }
  return 0
}
function Win32Of([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return @(0, 0, 0, [int64]0) }
  $p = [uint32]0
  [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  $top = [W]::GetAncestor($h, 2)
  $sb = New-Object System.Text.StringBuilder 256
  [void][W]::GetClassName($h, $sb, 256)
  $cls = $sb.ToString()
  $secure = 0
  $known = 0
  if ($cls -match $editClass) {
    $known = 1
    $style = [W]::GetWindowLong($h, -16)
    $pw = [W]::SendMessage($h, 0x00D2, [IntPtr]::Zero, [IntPtr]::Zero)
    if (($style -band 0x20) -ne 0 -or $pw.ToInt64() -ne 0) { $secure = 1 }
  }
  return @([int]$p, $secure, $known, [int64]$top)
}
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Split(' ')
  try {
    $uiaPid = 0; $uiaSecure = 0; $uiaKnown = 0; $uiaTop = [int64]0
    $h = [IntPtr]::Zero
    $el = $null
    if ($parts[0] -eq 'select') {
      # A row is selected without moving the pointer. Cua's Windows "pick" click moved
      # the real cursor onto the row and back, and the user sees that. sel 1 = selected, sel 0 =
      # nothing selectable at that rect, sel 2 = sent but final selection differs from the target;
      # the second digit says the selection moved the foreground,
      # which the caller reports instead of claiming a background selection.
      $top = [IntPtr][int64]$parts[1]
      $bLeft = [double]$parts[2]; $bTop = [double]$parts[3]
      $bRight = [double]$parts[4]; $bBottom = [double]$parts[5]
      # The very same conversion as the element query: the caller sends a global
      # logical rect, UI Automation answers in physical pixels, so scale by the target window's
      # own per-monitor scale. UIA also tries the raw/inverse rect with EdgeScore; ListBox hit
      # testing only uses the first rect, since an alternate centre can name a different row.
      $scale = DpiScaleOf $top
      $cands = @()
      foreach ($s in @($scale, 1.0, (1.0 / $scale))) {
        $cands += ,@(($bLeft * $s), ($bTop * $s), ($bRight * $s), ($bBottom * $s))
      }
      $fgBefore = [W]::GetForegroundWindow()
      # A classic list takes its row through its own window messages, which the managed UI
      # Automation client cannot reach; only a row no such control owns falls
      # through to the SelectionItem pattern.
      $done = SelectInList $top $cands
      if ($done -eq 0) {
        $best = 0
        $hit = $null
        try {
          $root = [System.Windows.Automation.AutomationElement]::FromHandle($top)
          if ($root) {
            # Only an element that can be selected is a candidate: a label inside the row is
            # smaller than the row and would win the rect score without being selectable.
            $pc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty, $true)
            foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $pc)) {
              $b = $c.Current.BoundingRectangle
              if ($b.IsEmpty) { continue }
              $r = @($b.Left, $b.Top, $b.Right, $b.Bottom)
              foreach ($q in $cands) {
                $s = EdgeScore $q $r
                if ($s -gt $best) { $best = $s; $hit = $c }
              }
            }
          }
        } catch {
          $hit = $null
        }
        if ($hit) {
          try {
            $pattern = $hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $pattern.Select()
            $done = 1
          } catch {
            $done = 0
          }
        }
      }
      # SelectionItemPattern.Select activates the window that owns a XAML control (a UWP tab was
      # pulled in front), so the foreground is observed rather than assumed.
      $stole = 0
      if ([W]::GetForegroundWindow() -ne $fgBefore) { $stole = 1 }
      [Console]::Out.WriteLine("sel $done $stole")
      [Console]::Out.Flush()
      continue
    } elseif ($parts[0] -eq 'element') {
      # A covered window cannot be asked about the point under the element: that point belongs
      # to whatever covers it. Look the element up by the rect the tree reported instead, and
      # let each source answer about that control only.
      $top = [IntPtr][int64]$parts[1]
      $bLeft = [double]$parts[2]; $bTop = [double]$parts[3]
      $bRight = [double]$parts[4]; $bBottom = [double]$parts[5]
      # The frame is a global logical rect; scale it to the pixels the two sources report in.
      # The raw rect and the inverse stay as fallbacks for a display whose DPI could not be read.
      # Unlike the point query this cannot name the wrong control: a candidate only matches a
      # control whose rect nearly coincides with it (EdgeScore), so a wrong scale ends as
      # "unknown" instead of selecting a neighbour.
      $scale = DpiScaleOf $top
      $cands = @()
      foreach ($s in @($scale, 1.0, (1.0 / $scale))) {
        $cands += ,@(($bLeft * $s), ($bTop * $s), ($bRight * $s), ($bBottom * $s))
      }
      $bestUia = 0
      try {
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($top)
        if ($root) {
          # Only a control that can be a text input has a meaningful IsPassword; a Pane (which
          # is how managed UI Automation shows WinForms edits) proves nothing, so it is not asked.
          foreach ($ct in @([System.Windows.Automation.ControlType]::Edit, [System.Windows.Automation.ControlType]::Document)) {
            $pc = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
            foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $pc)) {
              $b = $c.Current.BoundingRectangle
              if ($b.IsEmpty) { continue }
              $r = @($b.Left, $b.Top, $b.Right, $b.Bottom)
              foreach ($q in $cands) {
                $s = EdgeScore $q $r
                if ($s -gt $bestUia) { $bestUia = $s; $el = $c }
              }
            }
          }
        }
      } catch {
        # A provider that cannot be walked only loses its own vote; the Win32 source is still
        # asked, and TS refuses unless a source proves the answer.
        $el = $null
      }
      $bestWin = 0
      $stack = New-Object System.Collections.Stack
      $stack.Push($top)
      $visited = 0
      while ($stack.Count -gt 0 -and $visited -lt 2000) {
        $visited++
        $parent = $stack.Pop()
        # PowerShell turns $null into "" for a .NET string parameter, so FindWindowEx looked for
        # a window whose class name is the empty string and found no child at all.
        $child = [W]::FindWindowEx($parent, [IntPtr]::Zero, [NullString]::Value, [NullString]::Value)
        while ($child -ne [IntPtr]::Zero) {
          $cb = New-Object System.Text.StringBuilder 256
          [void][W]::GetClassName($child, $cb, 256)
          $cr = [W+RECT]::new()
          if (($cb.ToString() -match $editClass) -and [W]::GetWindowRect($child, [ref]$cr)) {
            $rr = @($cr.left, $cr.top, $cr.right, $cr.bottom)
            foreach ($q in $cands) {
              $s = EdgeScore $q $rr
              if ($s -gt $bestWin) { $bestWin = $s; $h = $child }
            }
          }
          $stack.Push($child)
          $child = [W]::FindWindowEx($parent, $child, [NullString]::Value, [NullString]::Value)
        }
      }
    } elseif ($parts[0] -eq 'point') {
      # parts: target window handle, then the point in global logical points. Probing the logical
      # point directly answered "another window" on a scaled display, which the caller reads as
      # "occluded" and then refuses the input.
      $top = [IntPtr][int64]$parts[1]
      $x = [int]$parts[2]; $y = [int]$parts[3]
      $scale = DpiScaleOf $top
      # Exactly one conversion, with no fallback to the raw point: on a scaled display the raw
      # point lands elsewhere on the screen, possibly on another control of the same window, and
      # a password question asked about the wrong control could answer "not a password field"
      # for the field the caller is about to write into. A point the conversion cannot place
      # inside the target window stays "elsewhere" (the caller reads occluded / unknown).
      $fx = [int][Math]::Round($x * $scale); $fy = [int][Math]::Round($y * $scale)
      $pt = [W+POINT]::new()
      $pt.x = $fx; $pt.y = $fy
      $h = [W]::WindowFromPoint($pt)
      if ($h -ne [IntPtr]::Zero) {
        try { $el = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new($fx, $fy)) } catch { $el = $null }
      }
    } else {
      $wid = [int64]$parts[1]
      $el = [System.Windows.Automation.AutomationElement]::FocusedElement
      $p = [uint32]0
      $thread = 0
      if ($wid -ne 0) {
        $thread = [W]::GetWindowThreadProcessId([IntPtr]$wid, [ref]$p)
      } else {
        $thread = [W]::GetWindowThreadProcessId([W]::GetForegroundWindow(), [ref]$p)
      }
      if ($thread -ne 0) {
        $gui = [W+GUITHREADINFO]::new()
        $gui.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($gui)
        if ([W]::GetGUIThreadInfo($thread, [ref]$gui)) { $h = $gui.hwndFocus }
      }
    }
    if ($el) {
      $uiaPid = [int]$el.Current.ProcessId
      $uiaSecure = [int]$el.Current.IsPassword
      $type = $el.Current.ControlType.ProgrammaticName
      if ($type -eq 'ControlType.Edit' -or $type -eq 'ControlType.Document') { $uiaKnown = 1 }
      $uiaTop = TopOf $el
    }
    $w = Win32Of $h
    [Console]::Out.WriteLine("ok $uiaPid $uiaSecure $uiaKnown $uiaTop $($w[0]) $($w[1]) $($w[2]) $($w[3])")
  } catch {
    [Console]::Out.WriteLine('none')
  }
  [Console]::Out.Flush()
}
`;

interface Source {
  pid: number;
  secure: boolean;
  /** Whether this source could see the control at all; false means "no evidence". */
  known: boolean;
  /** Top-level window handle, decimal; "0" when the source saw no window. */
  top: string;
}

interface FocusAnswer {
  uia: Source;
  win32: Source;
}

/**
 * One answer line. The password verdict is two sources about one control; the selection query
 * answers a different question, so the two are told apart instead of sharing a shape.
 */
type ProbeAnswer =
  | { kind: "focus"; focus: FocusAnswer }
  | {
      kind: "select";
      selection: "unsupported" | "confirmed" | "unverified";
      /** The selection itself moved the foreground window. */
      foregroundChanged: boolean;
    };

/** One query line the resident helper understands ("point x y", "focus windowId", "element …", "select …"). */
type ProbeQuery = (line: string, signal?: AbortSignal) => Promise<ProbeAnswer | undefined>;

type Helper = ChildProcessByStdio<Writable, Readable, null>;

/**
 * One resident PowerShell, started on the first query. A failed, timed-out or aborted query only
 * means "unknown", never "not a password field"; the next query starts a fresh helper.
 */
function createResidentProbe(): { probe: ProbeQuery; stop(): void } {
  let child: Helper | undefined;
  let buffer = "";
  let ready = false;
  let readyWaiters: Array<(ok: boolean) => void> = [];
  let pending:
    | {
        resolve: (answer: ProbeAnswer | undefined) => void;
        timer: ReturnType<typeof setTimeout>;
        signal?: AbortSignal;
        onAbort?: () => void;
      }
    | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const markReady = (ok: boolean) => {
    ready = ok;
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const waiter of waiters) waiter(ok);
  };

  const settle = (answer: ProbeAnswer | undefined) => {
    const current = pending;
    if (!current) return;
    pending = undefined;
    clearTimeout(current.timer);
    if (current.signal && current.onAbort)
      current.signal.removeEventListener("abort", current.onAbort);
    current.resolve(answer);
  };

  const stopChild = () => {
    markReady(false);
    const current = child;
    child = undefined;
    buffer = "";
    if (!current) return;
    current.stdin.end();
    current.kill();
  };

  const onLine = (line: string) => {
    const text = line.trim();
    if (!text) return;
    if (text === "ready") return markReady(true);
    if (text === "none") return settle(undefined);
    const selected = /^sel ([012]) ([01])$/.exec(text);
    if (selected)
      return settle({
        kind: "select",
        selection:
          selected[1] === "2" ? "unverified" : selected[1] === "1" ? "confirmed" : "unsupported",
        foregroundChanged: selected[2] === "1",
      });
    const match =
      /^ok (\d{1,10}) ([01]) ([01]) (\d{1,20}) (\d{1,10}) ([01]) ([01]) (\d{1,20})$/.exec(text);
    if (!match) return settle(undefined);
    const [, uiaPid, uiaSecure, uiaKnown, uiaTop, winPid, winSecure, winKnown, winTop] = match;
    if (
      !uiaPid ||
      !uiaSecure ||
      !uiaKnown ||
      !uiaTop ||
      !winPid ||
      !winSecure ||
      !winKnown ||
      !winTop
    )
      return settle(undefined);
    settle({
      kind: "focus",
      focus: {
        uia: {
          pid: Number(uiaPid),
          secure: uiaSecure === "1",
          known: uiaKnown === "1",
          top: uiaTop,
        },
        win32: {
          pid: Number(winPid),
          secure: winSecure === "1",
          known: winKnown === "1",
          top: winTop,
        },
      },
    });
  };

  const start = (): Helper => {
    ready = false;
    const started = spawnScriptHelper(SCRIPT);
    started.stdout.setEncoding("utf8");
    started.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const at = buffer.indexOf("\n");
        if (at < 0) break;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        onLine(line);
      }
    });
    // A dead or unstartable helper only means "unknown"; the next query starts a new one.
    // Only the live helper may say so: an old process finishing after a restart used to mark the
    // new one unready and fail the first query after release() or a timeout.
    const died = () => {
      if (child !== started) return;
      child = undefined;
      markReady(false);
      settle(undefined);
    };
    started.on("error", died);
    started.on("exit", died);
    child = started;
    return started;
  };

  const waitReady = (started: Helper, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (ready) return resolve(true);
      if (child !== started) return resolve(false);
      const timer = setTimeout(() => {
        if (child === started) stopChild();
        resolve(false);
      }, STARTUP_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      readyWaiters.push((ok) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(ok);
      });
    });

  const ask = async (line: string, signal?: AbortSignal): Promise<ProbeAnswer | undefined> => {
    if (signal?.aborted) return undefined;
    let started: Helper;
    try {
      started = child ?? start();
    } catch {
      // Starting the helper failed outright (no powershell.exe, no writable temp directory). No
      // query was made and nothing was typed, so the answer must be "unknown" — the caller then
      // refuses before delivery. Letting this reject turned it into a driver_error whose
      // disposition said the step may have gone through.
      child = undefined;
      return undefined;
    }
    if (!(await waitReady(started, signal))) return undefined;
    if (signal?.aborted) return undefined;
    return new Promise<ProbeAnswer | undefined>((resolve) => {
      const timer = setTimeout(() => {
        // A helper that missed its deadline cannot be trusted for the next query either.
        if (child === started) stopChild();
        settle(undefined);
      }, QUERY_TIMEOUT_MS);
      const onAbort = () => {
        if (child === started) stopChild();
        settle(undefined);
      };
      pending = { resolve, timer, signal, onAbort };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        started.stdin.write(`${line}\n`);
      } catch {
        // The helper died between the check and the write; the exit handler settles this query.
        if (child === started) stopChild();
        settle(undefined);
      }
    });
  };

  return {
    probe: (line, signal) => {
      // One query at a time: the helper answers in order, and two writers would mix lines.
      const next = queue.then(() => ask(line, signal));
      queue = next.catch(() => undefined);
      return next;
    },
    stop: () => {
      settle(undefined);
      stopChild();
    },
  };
}

/** HWNDs are decimal strings; leading zeros are not part of the identity. */
function sameHandle(a: string, b: string): boolean {
  return a.replace(/^0+(?=\d)/, "") === b.replace(/^0+(?=\d)/, "");
}

/**
 * Both readers' answers about one control, merged. Evidence only counts when it is about the
 * target pid and the target window: the same app's other window says nothing about the field
 * we are about to write into. Either source saying "password" refuses; one source that saw the
 * control and saw no password proves it is not one. (Managed UI Automation reports WinForms /
 * Win32 edits as a Pane it cannot judge while the Win32 edit style can, and Chrome's edits have
 * no edit-class child window while UIA can read IsPassword, so requiring both would refuse
 * every plain text box on one of the two.) Nothing else is "unknown", and callers
 * refuse then. A focus that is not an edit / document (a button, a document pane that reports no
 * edit, no focus at all) has no evidence from either reader and stays "unknown" — the same
 * fail-closed rule macOS got explicitly for free-form keys.
 */
function judge(pid: number, windowId: string | undefined, found: FocusAnswer): boolean | "unknown" {
  const onTarget = (source: Source) =>
    source.known &&
    source.pid === pid &&
    (windowId === undefined || sameHandle(source.top, windowId));
  const uia = onTarget(found.uia);
  const win = onTarget(found.win32);
  if (uia || win) return (uia && found.uia.secure) || (win && found.win32.secure);
  return "unknown";
}

/** A window handle that can be sent on the query line (decimal, as Cua reports it). */
const handleable = (windowId: string) => /^\d{1,20}$/.test(windowId);

/**
 * `secureFocus` / `secureElement` for the Windows driver. A point that landed in another window
 * (the target is covered) is reported as "occluded" so the caller can ask about the element
 * itself instead of a point it cannot judge.
 */
export function createWindowsSecureFocus(probe = createResidentProbe()) {
  return {
    async secureFocus(
      pid: number,
      at?: Point,
      signal?: AbortSignal,
      windowId?: string,
    ): Promise<boolean | "unknown" | "occluded"> {
      // A point can only be placed on the screen once its DPI is known, and the DPI comes from
      // the window it belongs to; without one the answer stays "unknown".
      const pointHandle = windowId !== undefined && handleable(windowId) ? windowId : undefined;
      if (at && pointHandle === undefined) return "unknown";
      const line = at
        ? `point ${pointHandle} ${Math.round(at.x)} ${Math.round(at.y)}`
        : `focus ${windowId ?? 0}`;
      const found = await probe.probe(line, signal);
      if (found?.kind !== "focus") return "unknown";
      const verdict = judge(pid, windowId, found.focus);
      if (verdict !== "unknown") return verdict;
      // A covered window cannot be judged from a point; the caller can then ask about
      // the element itself or bring the window forward. Without a window id there is nothing to
      // compare.
      if (at && windowId !== undefined) {
        const elsewhere = [found.focus.uia, found.focus.win32].some(
          (source) => source.top !== "0" && !sameHandle(source.top, windowId),
        );
        if (elsewhere) return "occluded";
      }
      return "unknown";
    },
    /**
     * The same question about one element of a window, asked by the element — its own
     * UIA element for IsPassword and its own HWND for the edit class and ES_PASSWORD /
     * EM_GETPASSWORDCHAR — so a covered window still gets an answer when a point does not. The
     * window is never brought forward.
     */
    async secureElement(
      window: WindowInfo,
      frame: Rect,
      signal?: AbortSignal,
    ): Promise<boolean | "unknown"> {
      if (!handleable(window.id) || frame.width <= 0 || frame.height <= 0) return "unknown";
      // The frame is already a global logical rect; the helper scales it to physical pixels with
      // the window's DPI. Subtracting the window's own bounds first was wrong on two counts: Cua
      // reports the visible frame while Win32 reports the DWM-extended one (they differ by the
      // invisible resize border), and the result was then compared against physical rects.
      const left = Math.round(frame.x);
      const top = Math.round(frame.y);
      const right = Math.round(frame.x + frame.width);
      const bottom = Math.round(frame.y + frame.height);
      const found = await probe.probe(
        `element ${window.id} ${left} ${top} ${right} ${bottom}`,
        signal,
      );
      if (found?.kind !== "focus") return "unknown";
      return judge(window.pid, window.id, found.focus);
    },
    /**
     * Select one item of `window` through the platform's own selection route, so the
     * real pointer stays where the user left it — Cua's Windows "pick" click moved it onto the
     * row and back. "unsupported" when nothing selectable sits at that rect; the caller
     * then refuses instead of clicking, because a silent cursor move is what we are avoiding.
     * "selected_foreground" when the selection itself brought the app forward: the
     * row is selected, but the caller must not report that as an invisible background step.
     */
    async selectElement(
      window: WindowInfo,
      frame: Rect,
      signal?: AbortSignal,
    ): Promise<
      "selected" | "selected_foreground" | "selected_unverified" | "unsupported" | "unknown"
    > {
      if (!handleable(window.id) || frame.width <= 0 || frame.height <= 0) return "unknown";
      // Global logical rect, exactly as secureElement sends it: the helper scales it with the
      // window's own DPI. Offsetting by the window's bounds first mixes Cua's visible frame with
      // Win32's DWM-extended one and leaves logical units for the helper to compare against
      // physical rects — a past bug (200% display: nothing ever matched).
      const left = Math.round(frame.x);
      const top = Math.round(frame.y);
      const right = Math.round(frame.x + frame.width);
      const bottom = Math.round(frame.y + frame.height);
      const found = await probe.probe(
        `select ${window.id} ${left} ${top} ${right} ${bottom}`,
        signal,
      );
      if (found?.kind !== "select") return "unknown";
      if (found.selection === "unverified") return "selected_unverified";
      if (found.selection === "unsupported") return "unsupported";
      return found.foregroundChanged ? "selected_foreground" : "selected";
    },
    release: () => probe.stop(),
  };
}
