// Mediarr Setup: asks where to install, checks for Node.js / Git / FFmpeg (offering to install any that
// are missing with winget), downloads the latest Mediarr release from GitHub, installs and builds it,
// adds shortcuts, registers it in Settings → Apps (so it can be uninstalled there) and starts it.
// The same exe is the uninstaller: setup copies it into the Mediarr folder as "Uninstall Mediarr.exe".
// Built with the C# compiler that ships with Windows (see build.ps1), so it runs on any Windows 10/11 PC.
//
// Command line (optional):
//   MediarrSetup.exe [--dir "D:\Mediarr"] [--no-shortcut] [--no-start] [--quiet]
//   "Uninstall Mediarr.exe" --uninstall [--keep-data] [--quiet]
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Management;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Mediarr Setup")]
[assembly: AssemblyProduct("Mediarr")]
[assembly: AssemblyDescription("Installs and uninstalls Mediarr")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

static class Program
{
    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var o = Options.Parse(args);
        if (o.Uninstall && Uninstaller.RelaunchOutsideFolder(o)) return;
        Application.Run(new SetupForm(o));
    }
}

class Options
{
    public string Dir;
    public bool NoShortcut, NoStart, Quiet, Uninstall, KeepData, FromTemp;
    /** The uninstaller copy in the Mediarr folder, which must close before that folder can be deleted. */
    public int WaitPid;

    public static Options Parse(string[] args)
    {
        var o = new Options();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].ToLowerInvariant();
            if (a == "--dir" && i + 1 < args.Length) o.Dir = args[++i];
            else if (a == "--no-shortcut") o.NoShortcut = true;
            else if (a == "--no-start") o.NoStart = true;
            else if (a == "--quiet") o.Quiet = true;
            else if (a == "--uninstall") o.Uninstall = true;
            else if (a == "--keep-data") o.KeepData = true;
            else if (a == "--from-temp") o.FromTemp = true;
            else if (a == "--wait-pid" && i + 1 < args.Length) int.TryParse(args[++i], out o.WaitPid);
        }
        return o;
    }
}

// ======================================================================================
// Theme: the same colours as the Mediarr web app.
// ======================================================================================

static class Theme
{
    public static readonly Color Bg = Color.FromArgb(14, 16, 22);
    public static readonly Color Panel = Color.FromArgb(22, 26, 34);
    public static readonly Color Raised = Color.FromArgb(28, 32, 41);
    public static readonly Color Line = Color.FromArgb(40, 44, 54);
    public static readonly Color LineStrong = Color.FromArgb(58, 63, 75);
    public static readonly Color Text = Color.FromArgb(236, 238, 243);
    public static readonly Color Muted = Color.FromArgb(150, 157, 174);
    public static readonly Color Accent = Color.FromArgb(242, 181, 68);
    public static readonly Color AccentHover = Color.FromArgb(255, 198, 94);
    public static readonly Color AccentInk = Color.FromArgb(27, 20, 5);
    public static readonly Color Danger = Color.FromArgb(242, 109, 109);
    public static readonly Color Ok = Color.FromArgb(76, 195, 138);

    public static Font Body(float size) { return new Font("Segoe UI", size); }
    public static Font Bold(float size) { return new Font("Segoe UI Semibold", size); }

    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    /** Dark title bar (Windows 10 2004+ / 11). */
    public static void DarkTitleBar(IntPtr hwnd)
    {
        int on = 1;
        try { if (DwmSetWindowAttribute(hwnd, 20, ref on, 4) != 0) DwmSetWindowAttribute(hwnd, 19, ref on, 4); } catch { }
    }
}

/** The orange "M" (like the tray icon and the web app's logo). */
class Logo : Control
{
    public Logo() { SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true); BackColor = Color.Transparent; }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
        using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 1, Height - 1), Width * 0.28f))
        using (var b = new SolidBrush(Theme.Accent)) g.FillPath(b, path);
        using (var f = new Font("Segoe UI", Height * 0.5f, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var b = new SolidBrush(Theme.AccentInk))
        using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            g.DrawString("M", f, b, new RectangleF(0, Height * 0.03f, Width, Height), fmt);
    }
}

/** Rounded button: "primary" is the orange one, otherwise a quiet dark one. Keyboard and Enter/Esc work as usual. */
class ThemedButton : Button
{
    public bool Primary;
    public bool DangerStyle;
    bool hover, down;

    public ThemedButton(string text, bool primary)
    {
        Text = text;
        Primary = primary;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Font = Theme.Bold(9.75f);
        Cursor = Cursors.Hand;
        Size = new Size(112, 36);
    }

    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { down = true; Invalidate(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Color fill, text, border;
        if (Primary)
        {
            fill = DangerStyle ? Theme.Danger : (hover ? Theme.AccentHover : Theme.Accent);
            if (down) fill = ControlPaint.Dark(fill, 0.05f);
            text = Theme.AccentInk;
            border = fill;
        }
        else
        {
            fill = hover ? Theme.LineStrong : Theme.Raised;
            text = Theme.Text;
            border = Theme.LineStrong;
        }
        if (!Enabled) { fill = Color.FromArgb(Primary ? 110 : 255, fill); text = Theme.Muted; }
        var r = new RectangleF(1, 1, Width - 3, Height - 3);
        using (var path = Theme.Rounded(r, 9))
        {
            using (var b = new SolidBrush(fill)) g.FillPath(b, path);
            using (var p = new Pen(border)) g.DrawPath(p, path);
        }
        if (Focused && ShowFocusCues)
            using (var path = Theme.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), 10))
            using (var p = new Pen(Theme.AccentHover, 1.5f)) g.DrawPath(p, path);
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
    }
}

/** Checkbox with a rounded orange box. */
class ThemedCheck : CheckBox
{
    public ThemedCheck(string text)
    {
        Text = text;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Font = Theme.Body(9.75f);
        ForeColor = Theme.Text;
        Cursor = Cursors.Hand;
        AutoSize = false;
        Height = 26;
    }

    protected override void OnCheckedChanged(EventArgs e) { Invalidate(); base.OnCheckedChanged(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var box = new RectangleF(1, (Height - 18) / 2f, 18, 18);
        using (var path = Theme.Rounded(box, 5))
        {
            using (var b = new SolidBrush(Checked ? (Enabled ? Theme.Accent : Theme.Muted) : Theme.Raised)) g.FillPath(b, path);
            using (var p = new Pen(Checked ? (Enabled ? Theme.Accent : Theme.Muted) : Theme.LineStrong)) g.DrawPath(p, path);
        }
        if (Checked)
            using (var p = new Pen(Theme.AccentInk, 2f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
                g.DrawLines(p, new[] { new PointF(box.X + 4.5f, box.Y + 9.5f), new PointF(box.X + 7.8f, box.Y + 12.8f), new PointF(box.X + 13.5f, box.Y + 5.5f) });
        if (Focused && ShowFocusCues)
            using (var path = Theme.Rounded(new RectangleF(box.X - 1, box.Y - 1, box.Width + 2, box.Height + 2), 6))
            using (var p = new Pen(Theme.AccentHover, 1.5f)) g.DrawPath(p, path);
        var textRect = new Rectangle(28, 0, Width - 28, Height);
        TextRenderer.DrawText(g, Text, Font, textRect, Enabled ? ForeColor : Theme.Muted, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.WordBreak);
    }
}

/** A dark rounded frame around a borderless text box. */
class Field : Panel
{
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    static extern int SetWindowTheme(IntPtr hwnd, string app, string idList);

    public readonly TextBox Box = new TextBox();
    public Field(bool multiline)
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
        BackColor = multiline ? Theme.Panel : Theme.Raised;
        Padding = multiline ? new Padding(10, 8, 4, 8) : new Padding(10, 8, 10, 6);
        Box.BorderStyle = BorderStyle.None;
        Box.BackColor = BackColor;
        Box.ForeColor = multiline ? Theme.Muted : Theme.Text;
        Box.Font = multiline ? new Font("Consolas", 8.75f) : Theme.Body(10f);
        Box.Multiline = multiline;
        Box.Dock = DockStyle.Fill;
        if (multiline) { Box.ReadOnly = true; Box.ScrollBars = ScrollBars.Vertical; }
        // Dark scroll bar (Windows 10 1809+ / 11).
        Box.HandleCreated += delegate { try { SetWindowTheme(Box.Handle, "DarkMode_Explorer", null); } catch { } };
        Box.GotFocus += delegate { Invalidate(); };
        Box.LostFocus += delegate { Invalidate(); };
        Controls.Add(Box);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Theme.Rounded(new RectangleF(0.5f, 0.5f, Width - 2, Height - 2), 9))
        {
            using (var b = new SolidBrush(BackColor)) g.FillPath(b, path);
            using (var p = new Pen(Box.Focused && !Box.ReadOnly ? Theme.Accent : Theme.Line)) g.DrawPath(p, path);
        }
    }
}

/** An orange stripe that slides along while something is happening. */
class Activity : Control
{
    readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer { Interval = 16 };
    float pos;
    public Activity()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Height = 6;
        timer.Tick += delegate { pos += 0.012f; if (pos > 1.3f) pos = -0.3f; Invalidate(); };
    }
    protected override void OnVisibleChanged(EventArgs e) { timer.Enabled = Visible; base.OnVisibleChanged(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var path = Theme.Rounded(new RectangleF(0, 0, Width - 1, Height - 1), 3))
        using (var b = new SolidBrush(Theme.Raised)) g.FillPath(b, path);
        float w = Width * 0.3f, x = pos * Width;
        var seg = RectangleF.Intersect(new RectangleF(x, 0, w, Height - 1), new RectangleF(0, 0, Width - 1, Height - 1));
        if (seg.Width > 2)
            using (var path = Theme.Rounded(seg, 3))
            using (var b = new SolidBrush(Theme.Accent)) g.FillPath(b, path);
    }
    protected override void Dispose(bool disposing) { if (disposing) timer.Dispose(); base.Dispose(disposing); }
}

/** Mediarr-styled message box (the message can be selected and copied, e.g. the setup code). */
class Dialog : Form
{
    int result = -1;

    Dialog(string title, string message, string[] buttons, int primary, bool danger)
    {
        Text = "Mediarr Setup";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.CenterParent;
        BackColor = Theme.Bg;
        ForeColor = Theme.Text;
        Font = Theme.Body(9.75f);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        int width = 460;
        var heading = new Label { Text = title, Font = Theme.Bold(13f), ForeColor = Theme.Text, AutoSize = false, Location = new Point(24, 20), Size = new Size(width - 48, 30) };
        var body = new TextBox
        {
            Text = message.Replace("\r\n", "\n").Replace("\n", "\r\n"), ReadOnly = true, Multiline = true, BorderStyle = BorderStyle.None,
            BackColor = Theme.Bg, ForeColor = Theme.Muted, Font = Theme.Body(9.75f), TabStop = false, Location = new Point(24, 56),
        };
        Size need = TextRenderer.MeasureText(body.Text, body.Font, new Size(width - 48, 0), TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl);
        body.Size = new Size(width - 48, Math.Min(need.Height + 8, 420));
        if (need.Height + 8 > 420) body.ScrollBars = ScrollBars.Vertical;
        Controls.Add(heading);
        Controls.Add(body);

        int y = body.Bottom + 22, x = width - 24;
        for (int i = buttons.Length - 1; i >= 0; i--)
        {
            int index = i;
            var b = new ThemedButton(buttons[i], i == primary) { DangerStyle = danger && i == primary };
            b.Width = Math.Max(96, TextRenderer.MeasureText(buttons[i], b.Font).Width + 36);
            x -= b.Width;
            b.Location = new Point(x, y);
            x -= 10;
            b.Click += delegate { result = index; Close(); };
            Controls.Add(b);
            if (i == primary) { AcceptButton = b; ActiveControl = b; }
        }
        ClientSize = new Size(width, y + 36 + 20);
    }

    protected override void OnHandleCreated(EventArgs e) { Theme.DarkTitleBar(Handle); base.OnHandleCreated(e); }

    /** Returns the index of the button pressed (-1 if the window was closed). */
    public static int Show(IWin32Window owner, string title, string message, string[] buttons, int primary, bool danger)
    {
        using (var d = new Dialog(title, message, buttons, primary, danger))
        {
            if (buttons.Length == 1) d.CancelButton = (IButtonControl)d.AcceptButton;
            d.ShowDialog(owner);
            return d.result;
        }
    }
}

// ======================================================================================
// The standard Windows folder picker (the File Explorer one), via IFileOpenDialog.
// ======================================================================================

static class FolderPicker
{
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialog { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItem item);

    const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800, SIGDN_FILESYSPATH = 0x80058000;

    /** The folder chosen, or null when cancelled. */
    public static string Pick(IWin32Window owner, string title, string startIn)
    {
        var dlg = (IFileDialog)new FileOpenDialog();
        try
        {
            dlg.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dlg.SetTitle(title);
            dlg.SetOkButtonLabel("Install here");
            if (!string.IsNullOrEmpty(startIn) && Directory.Exists(startIn))
            {
                try
                {
                    IShellItem start;
                    SHCreateItemFromParsingName(startIn, IntPtr.Zero, typeof(IShellItem).GUID, out start);
                    dlg.SetFolder(start);
                }
                catch { }
            }
            if (dlg.Show(owner != null ? owner.Handle : IntPtr.Zero) != 0) return null;
            IShellItem item;
            dlg.GetResult(out item);
            string path;
            item.GetDisplayName(SIGDN_FILESYSPATH, out path);
            return path;
        }
        finally { Marshal.ReleaseComObject(dlg); }
    }
}

// ======================================================================================
// The window (install or uninstall).
// ======================================================================================

class Stop : Exception { public Stop(string m) : base(m) { } }

class SetupForm : Form
{
    const string Repo = "Scrapper1824/Mediarr";
    const string RepoUrl = "https://github.com/Scrapper1824/Mediarr.git";
    public const int Port = 7979;
    static readonly Version MinNode = new Version(22, 13, 0);

    /** Everything shown in the log is also kept in %TEMP%\MediarrSetup.log (for troubleshooting). */
    public static readonly string LogFile = Path.Combine(Path.GetTempPath(), "MediarrSetup.log");
    static readonly object LogLock = new object();

    readonly Options opts;
    readonly Field folder = new Field(false);
    readonly ThemedButton browse = new ThemedButton("Browse…", false);
    readonly ThemedCheck shortcutBox = new ThemedCheck("Add Mediarr to the Start menu and the desktop");
    readonly ThemedCheck startBox = new ThemedCheck("Start Mediarr when setup finishes");
    readonly ThemedCheck deleteDataBox = new ThemedCheck("Also delete my Mediarr data (settings, users, watch history)");
    readonly Field log = new Field(true);
    readonly Activity activity = new Activity();
    readonly Label status = new Label();
    readonly ThemedButton go;
    readonly ThemedButton cancel = new ThemedButton("Cancel", false);
    readonly string uninstallDir;
    bool running, finished;

    public SetupForm(Options o)
    {
        opts = o;
        bool un = o.Uninstall;
        if (un) uninstallDir = Uninstaller.TargetDir(o);

        Text = un ? "Uninstall Mediarr" : "Mediarr Setup";
        Font = Theme.Body(9.75f);
        BackColor = Theme.Bg;
        ForeColor = Theme.Text;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(640, 520);
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var logo = new Logo { Location = new Point(28, 26), Size = new Size(44, 44) };
        var title = new Label { Text = un ? "Uninstall Mediarr" : "Install Mediarr", Font = Theme.Bold(18f), ForeColor = Theme.Text, AutoSize = true, Location = new Point(84, 22) };
        var sub = new Label
        {
            Text = un ? "Removes Mediarr from this PC." : "Your own movie, show and anime server.",
            ForeColor = Theme.Muted, AutoSize = true, Location = new Point(86, 56),
        };
        var intro = new Label
        {
            ForeColor = Theme.Muted, Location = new Point(28, 92), Size = new Size(584, 44),
            Text = un
                ? "This stops Mediarr and removes it from " + uninstallDir + ", along with its shortcuts and its entry in Settings → Apps. Your movies, shows and anime in your library folders are never touched."
                : "Downloads the latest Mediarr from GitHub and sets it up on this PC. Mediarr keeps its settings and library database inside the folder you choose, so pick one you can write to.",
        };
        Controls.AddRange(new Control[] { logo, title, sub, intro });

        go = new ThemedButton(un ? "Uninstall" : "Install", true) { DangerStyle = un };
        // As tall as its text needs (the uninstall one names the folder, which can be long).
        intro.Height = TextRenderer.MeasureText(intro.Text, Font, new Size(intro.Width, 0), TextFormatFlags.WordBreak).Height + 4;
        int y = intro.Bottom + 14;
        if (!un)
        {
            var folderLabel = new Label { Text = "INSTALL TO", Font = Theme.Bold(8f), ForeColor = Theme.Muted, AutoSize = true, Location = new Point(28, y) };
            folder.Location = new Point(28, y + 22);
            folder.Size = new Size(466, 38);
            folder.Box.Text = o.Dir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mediarr");
            browse.Location = new Point(504, y + 23);
            browse.Size = new Size(108, 36);
            browse.Click += delegate { Browse(); };
            shortcutBox.Checked = !o.NoShortcut;
            shortcutBox.Location = new Point(28, y + 74);
            shortcutBox.Width = 584;
            startBox.Checked = !o.NoStart;
            startBox.Location = new Point(28, y + 102);
            startBox.Width = 584;
            Controls.AddRange(new Control[] { folderLabel, folder, browse, shortcutBox, startBox });
            y += 142;
        }
        else
        {
            deleteDataBox.Checked = !o.KeepData && o.Quiet;
            deleteDataBox.Location = new Point(28, y);
            deleteDataBox.Width = 584;
            var dataHint = new Label
            {
                ForeColor = Theme.Muted, Location = new Point(56, y + 28), Size = new Size(556, 36),
                Text = "Leave this off to keep them in " + Path.Combine(uninstallDir, "data") + ", so installing Mediarr there again picks up where you left off.",
            };
            Controls.AddRange(new Control[] { deleteDataBox, dataHint });
            y += 76;
        }

        log.Location = new Point(28, y);
        log.Size = new Size(584, 400 - y + 20);
        status.Location = new Point(28, log.Bottom + 12);
        status.Size = new Size(584, 22);
        status.ForeColor = Theme.Text;
        status.Text = un ? "Ready to uninstall." : "Ready to install.";
        activity.Location = new Point(28, status.Bottom + 6);
        activity.Size = new Size(330, 6);
        activity.Visible = false;
        go.Location = new Point(ClientSize.Width - 28 - 112 - 10 - 112, ClientSize.Height - 28 - 36);
        cancel.Location = new Point(ClientSize.Width - 28 - 112, ClientSize.Height - 28 - 36);
        go.Click += delegate { Start(); };
        cancel.Click += delegate { Close(); };
        AcceptButton = go;
        log.Box.Text = (un ? "What the uninstaller does" : "What setup does") + " will show here." + Environment.NewLine;
        Controls.AddRange(new Control[] { log, status, activity, go, cancel });

        FormClosing += (s, e) =>
        {
            if (running && !finished && Ask("Stop?", "Setup is still running. Stop it now?", "Stop", "Keep going", true) != true)
                e.Cancel = true;
        };
        FormClosed += delegate { if (opts.FromTemp) Uninstaller.DeleteSelfLater(); };
        if (o.Quiet) Shown += delegate { Start(); };
    }

    protected override void OnHandleCreated(EventArgs e) { Theme.DarkTitleBar(Handle); base.OnHandleCreated(e); }

    void Browse()
    {
        string current = folder.Box.Text.Trim();
        string startIn = null;
        try { startIn = Directory.Exists(current) ? current : Path.GetDirectoryName(current); } catch { }
        string picked = FolderPicker.Pick(this, "Choose where to install Mediarr (a \"Mediarr\" folder is made inside it)", startIn);
        if (picked == null) return;
        bool named = string.Equals(Path.GetFileName(picked.TrimEnd('\\')), "Mediarr", StringComparison.OrdinalIgnoreCase);
        folder.Box.Text = named ? picked : Path.Combine(picked, "Mediarr");
    }

    // ---------- UI helpers (safe from the worker thread) ----------

    public void Log(string line)
    {
        lock (LogLock) { try { File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine); } catch { } }
        if (InvokeRequired) { BeginInvoke(new Action<string>(AddToLog), line); return; }
        AddToLog(line);
    }

    void AddToLog(string line) { log.Box.AppendText(line + Environment.NewLine); }

    public void Status(string text)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string>(Status), text); return; }
        status.Text = text;
        Log("== " + text);
    }

    /** Yes/no question in Mediarr's style. Null when the window was closed. */
    public bool? Ask(string title, string question, string yes, string no, bool danger)
    {
        if (InvokeRequired) return (bool?)Invoke(new Func<string, string, string, string, bool, bool?>(Ask), title, question, yes, no, danger);
        int r = Dialog.Show(this, title, question, new[] { no, yes }, 1, danger);
        return r < 0 ? (bool?)null : r == 1;
    }

    public bool AskYes(string title, string question, string yes, string no) { return Ask(title, question, yes, no, false) == true; }

    public void Tell(string title, string text)
    {
        if (InvokeRequired) { Invoke(new Action<string, string>(Tell), title, text); return; }
        Dialog.Show(this, title, text, new[] { "OK" }, 0, false);
    }

    // ---------- Running ----------

    void Start()
    {
        if (running) return;
        string dir = null;
        if (!opts.Uninstall)
        {
            try { dir = Path.GetFullPath(Environment.ExpandEnvironmentVariables(folder.Box.Text.Trim())); }
            catch { Tell("Check the folder", "That isn't a valid folder path."); return; }
        }
        running = true;
        log.Box.Clear();
        foreach (Control c in new Control[] { folder, browse, shortcutBox, startBox, deleteDataBox, go }) c.Enabled = false;
        activity.Visible = true;
        bool shortcuts = shortcutBox.Checked, startAfter = startBox.Checked, deleteData = deleteDataBox.Checked;

        var worker = new Thread(() =>
        {
            string error = null, done = null;
            try
            {
                done = opts.Uninstall ? new Uninstaller(this, opts.WaitPid).Run(uninstallDir, deleteData) : Install(dir, shortcuts, startAfter);
            }
            catch (Stop s) { error = s.Message; }
            catch (Exception ex) { error = (opts.Uninstall ? "Uninstalling stopped: " : "Setup stopped: ") + ex.Message; }
            BeginInvoke(new Action(() => Finish(error, done)));
        });
        worker.IsBackground = true;
        worker.Start();
    }

    void Finish(string error, string done)
    {
        finished = true;
        activity.Visible = false;
        cancel.Text = "Close";
        cancel.Primary = error == null;
        cancel.Invalidate();
        AcceptButton = cancel;
        if (error != null)
        {
            status.Text = opts.Uninstall ? "Mediarr wasn't fully removed." : "Setup didn't finish.";
            Log("!! " + error);
            go.Text = "Try again";
            foreach (Control c in new Control[] { folder, browse, shortcutBox, startBox, deleteDataBox, go }) c.Enabled = true;
            running = finished = false;
            if (!opts.Quiet) Tell(opts.Uninstall ? "Couldn't uninstall" : "Setup didn't finish", error + "\n\nThe full log is in " + LogFile + ".");
            else Environment.ExitCode = 1;
        }
        else
        {
            status.Text = opts.Uninstall ? "Mediarr was removed." : "Mediarr is installed.";
            go.Visible = false;
            if (!opts.Quiet) Tell(opts.Uninstall ? "Uninstalled" : "All set", done);
        }
        if (opts.Quiet) Close();
    }

    // ---------- Install ----------

    string Install(string dir, bool shortcuts, bool startAfter)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

        // 1. Where: an empty (or new) folder, or an existing Mediarr copy to repair.
        bool existing = Uninstaller.IsMediarrCopy(dir);
        if (!existing && Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length > 0)
            throw new Stop("\"" + dir + "\" already has other files in it. Choose an empty folder, or a new one.");
        if (existing && !opts.Quiet && !AskYes("Already installed", "Mediarr is already installed in\n" + dir +
                "\n\nReinstall its packages and rebuild it? Your settings, users and library stay as they are.\n(For a newer version, use Settings → System → Updates in Mediarr.)",
                "Reinstall", "Cancel"))
            throw new Stop("Nothing was changed.");
        try
        {
            Directory.CreateDirectory(dir);
            string probe = Path.Combine(dir, ".setup-write-test");
            File.WriteAllText(probe, "ok");
            File.Delete(probe);
        }
        catch (Exception ex)
        {
            throw new Stop("Mediarr can't write to \"" + dir + "\" (" + ex.Message + "). Choose a folder in your user folder, for example " +
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mediarr") + ".");
        }
        Log("Installing to " + dir);

        // 2. What it needs.
        Status("Checking for Node.js, Git and FFmpeg…");
        RefreshPath();
        string node = EnsureNode();
        string git = EnsureTool("Git", "git.exe", "Git.Git", "https://git-scm.com/download/win", true,
            "Mediarr uses Git to download itself and its updates.",
            new[] { @"%ProgramFiles%\Git\cmd\git.exe", @"%LocalAppData%\Programs\Git\cmd\git.exe" });
        EnsureTool("FFmpeg", "ffmpeg.exe", "Gyan.FFmpeg", "https://www.gyan.dev/ffmpeg/builds/", false,
            "Mediarr uses FFmpeg to play videos in the browser (converting them when needed), for seek-bar thumbnails and to find intros. Everything else works without it, and you can install it later.",
            new[] { @"%LocalAppData%\Microsoft\WinGet\Links\ffmpeg.exe" });

        // 3. Download.
        if (!existing)
        {
            Status("Finding the latest release…");
            string tag = LatestTag();
            Log(tag != null ? "Latest release: " + tag : "No release found; using the newest code.");
            Status("Downloading Mediarr from GitHub…");
            Run(git, new[] { "clone", RepoUrl, dir }, null, "Downloading Mediarr");
            // Stay on main (so in-app updates can move it forward), at the released version.
            if (tag != null) Run(git, new[] { "reset", "--hard", tag }, dir, "Choosing " + tag);
        }

        // 4. Install packages and build.
        string npmCli = Path.Combine(Path.GetDirectoryName(node), @"node_modules\npm\bin\npm-cli.js");
        if (!File.Exists(npmCli)) throw new Stop("npm wasn't found next to Node.js (" + node + "). Reinstall Node.js, then run Mediarr Setup again.");
        Status("Installing packages (this takes a minute or two)…");
        Run(node, new[] { npmCli, "ci", "--no-audit", "--no-fund" }, dir, "Installing packages");
        Status("Building Mediarr…");
        Run(node, new[] { npmCli, "run", "build" }, dir, "Building");

        // 5. Uninstaller + Settings → Apps.
        Status("Registering Mediarr in Settings → Apps…");
        string uninstaller = Path.Combine(dir, Uninstaller.ExeName);
        try
        {
            if (!string.Equals(Path.GetFullPath(Application.ExecutablePath), uninstaller, StringComparison.OrdinalIgnoreCase))
                File.Copy(Application.ExecutablePath, uninstaller, true);
            Uninstaller.Register(dir, uninstaller);
        }
        catch (Exception ex) { Log("Couldn't register the uninstaller: " + ex.Message); }

        // 6. Shortcuts.
        string vbs = Path.Combine(dir, @"tray\Mediarr.vbs");
        if (shortcuts)
        {
            Status("Adding shortcuts…");
            try
            {
                foreach (string lnk in Uninstaller.ShortcutPaths())
                    MakeShortcut(lnk, vbs, dir, File.Exists(uninstaller) ? uninstaller : null);
            }
            catch (Exception ex) { Log("Couldn't add shortcuts: " + ex.Message); }
        }

        // 7. Start.
        string url = "http://localhost:" + Port;
        string started = "";
        if (startAfter)
        {
            if (PortAnswers())
            {
                started = "\n\nSomething is already running on port " + Port + " (maybe another copy of Mediarr), so this one wasn't started. Stop the other one, then start Mediarr from the Start menu.";
            }
            else
            {
                Status("Starting Mediarr…");
                Process.Start(new ProcessStartInfo("wscript.exe", Quote(vbs)) { WorkingDirectory = dir, UseShellExecute = false });
                bool up = false;
                for (int i = 0; i < 60 && !(up = PortAnswers()); i++) Thread.Sleep(1000);
                if (up)
                {
                    try { Process.Start(url); } catch { }
                    string codeFile = Path.Combine(dir, @"data\setup-code.txt");
                    string code = File.Exists(codeFile) ? File.ReadAllText(codeFile).Trim() : null;
                    started = "\n\nIt's running in the background (the orange M by the clock) and opening in your browser: " + url +
                        (string.IsNullOrEmpty(code) ? "" : "\n\nTo create your admin account, use this setup code:\n" + code + "\n(It's also in " + codeFile + ".)");
                }
                else
                {
                    started = "\n\nIt's starting in the background; open " + url + " in a minute. If it doesn't come up, right-click the orange M by the clock → Open log.";
                }
            }
        }

        Status("Done.");
        return "Mediarr is installed in " + dir + "." + started +
            (shortcuts ? "\n\nStart it any time from the Start menu or the desktop." : "") +
            "\n\nUpdates appear inside Mediarr (Settings → System → Updates). To remove it, use Settings → Apps → Mediarr → Uninstall.";
    }

    // ---------- Dependencies ----------

    string EnsureNode()
    {
        string need = MinNode.ToString(2) + "." + MinNode.Build;
        for (int attempt = 0; ; attempt++)
        {
            string node = FindExe("node.exe", new[] { @"%ProgramFiles%\nodejs\node.exe" });
            Version v = node != null ? NodeVersion(node) : null;
            if (v != null && v >= MinNode) { Log("Node.js " + v + " — " + node); return node; }
            if (attempt > 0)
                throw new Stop("Node.js " + need + " or newer still isn't available" + (v != null ? " (found " + v + ")" : "") +
                    ". Install it from https://nodejs.org (the LTS version), then run Mediarr Setup again.");
            string have = v != null ? "You have Node.js " + v + ", which is too old." : "Node.js isn't installed on this PC.";
            if (!AskYes("Node.js is needed", have + "\n\nMediarr runs on Node.js (version " + need + " or newer). Install the current Node.js LTS now?", "Install Node.js", "Cancel"))
                throw new Stop("Mediarr needs Node.js " + need + " or newer. Install it from https://nodejs.org, then run Mediarr Setup again.");
            WingetInstall("OpenJS.NodeJS.LTS", "Node.js", "https://nodejs.org", v != null);
        }
    }

    string EnsureTool(string name, string exe, string wingetId, string page, bool required, string why, string[] extra)
    {
        string found = FindExe(exe, extra);
        if (found != null) { Log(name + " — " + found); return found; }
        if (!AskYes(name + (required ? " is needed" : " is missing"), name + " isn't installed on this PC.\n\n" + why + "\n\nInstall " + name + " now?",
                "Install " + name, required ? "Cancel" : "Skip"))
        {
            if (required) throw new Stop("Mediarr needs " + name + ". Install it (" + page + "), then run Mediarr Setup again.");
            Log(name + " skipped. Install it later for playback: " + page);
            return null;
        }
        WingetInstall(wingetId, name, page, false);
        found = FindExe(exe, extra);
        if (found == null)
        {
            if (required) throw new Stop(name + " was installed but can't be found yet. Restart your PC, then run Mediarr Setup again.");
            Log(name + " was installed; Mediarr will find it after a restart.");
        }
        else Log(name + " — " + found);
        return found;
    }

    void WingetInstall(string id, string name, string page, bool upgrade)
    {
        string winget = FindExe("winget.exe", new[] { @"%LocalAppData%\Microsoft\WindowsApps\winget.exe" });
        if (winget == null)
        {
            if (AskYes("Can't install " + name, "Setup can't install " + name + " by itself on this PC (the Windows package manager, winget, isn't available).\n\nOpen the " + name + " download page instead?", "Open download page", "Cancel"))
                try { Process.Start(page); } catch { }
            throw new Stop("Install " + name + ", then run Mediarr Setup again.");
        }
        Status("Installing " + name + " (Windows may ask for permission)…");
        var common = new[] { "--id", id, "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--silent", "--disable-interactivity" };
        int code = RunCode(winget, Concat(new[] { upgrade ? "upgrade" : "install" }, common), null);
        if (code != 0 && !upgrade) code = RunCode(winget, Concat(new[] { "upgrade" }, common), null);
        Log("winget finished (" + code + ").");
        RefreshPath();
    }

    static Version NodeVersion(string node)
    {
        try
        {
            var p = Process.Start(new ProcessStartInfo(node, "-v") { UseShellExecute = false, RedirectStandardOutput = true, CreateNoWindow = true });
            string o = p.StandardOutput.ReadToEnd();
            p.WaitForExit(10000);
            Match m = Regex.Match(o, @"v(\d+)\.(\d+)\.(\d+)");
            return m.Success ? new Version(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value)) : null;
        }
        catch { return null; }
    }

    /** PATH as Windows has it now (programs installed a moment ago included). */
    static void RefreshPath()
    {
        string machine = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.Machine) ?? "";
        string user = Environment.GetEnvironmentVariable("Path", EnvironmentVariableTarget.User) ?? "";
        Environment.SetEnvironmentVariable("Path", Environment.ExpandEnvironmentVariables(machine + ";" + user));
    }

    static string FindExe(string exe, string[] extra)
    {
        foreach (string d in (Environment.GetEnvironmentVariable("Path") ?? "").Split(';'))
        {
            if (d.Trim().Length == 0) continue;
            try
            {
                string p = Path.Combine(Environment.ExpandEnvironmentVariables(d.Trim().Trim('"')), exe);
                if (File.Exists(p)) return p;
            }
            catch { }
        }
        foreach (string e in extra)
        {
            string p = Environment.ExpandEnvironmentVariables(e);
            if (File.Exists(p)) return p;
        }
        return null;
    }

    string LatestTag()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/" + Repo + "/releases/latest");
            req.UserAgent = "mediarr-setup";
            req.Accept = "application/vnd.github+json";
            req.Timeout = 20000;
            using (var res = req.GetResponse())
            using (var r = new StreamReader(res.GetResponseStream()))
            {
                Match m = Regex.Match(r.ReadToEnd(), "\"tag_name\"\\s*:\\s*\"(v\\d+\\.\\d+\\.\\d+)\"");
                return m.Success ? m.Groups[1].Value : null;
            }
        }
        catch (Exception ex)
        {
            Log("Couldn't ask GitHub for the latest release (" + ex.Message + ").");
            return null;
        }
    }

    public static bool PortAnswers()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/auth/status");
            req.Timeout = 1500;
            using (req.GetResponse()) return true;
        }
        catch (WebException ex) { return ex.Response != null; }
        catch { return false; }
    }

    static void MakeShortcut(string lnkPath, string vbs, string dir, string iconExe)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object lnk = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
        Type t = lnk.GetType();
        Action<string, object> set = (prop, value) => t.InvokeMember(prop, BindingFlags.SetProperty, null, lnk, new[] { value });
        set("TargetPath", Path.Combine(Environment.SystemDirectory, "wscript.exe"));
        set("Arguments", Quote(vbs));
        set("WorkingDirectory", dir);
        set("Description", "Start Mediarr (it runs in the system tray)");
        if (iconExe != null) set("IconLocation", iconExe + ",0");
        t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    // ---------- Running programs ----------

    void Run(string file, string[] args, string cwd, string label)
    {
        int code = RunCode(file, args, cwd);
        if (code != 0) throw new Stop(label + " failed (exit code " + code + "). The details are in the log.");
    }

    int RunCode(string file, string[] args, string cwd)
    {
        var sb = new StringBuilder();
        foreach (string a in args) sb.Append(sb.Length > 0 ? " " : "").Append(Quote(a));
        Log("> " + Path.GetFileName(file) + " " + sb);
        var psi = new ProcessStartInfo(file, sb.ToString())
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (cwd != null) psi.WorkingDirectory = cwd;
        psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0";
        psi.EnvironmentVariables["Path"] = Environment.GetEnvironmentVariable("Path");
        using (var p = new Process { StartInfo = psi })
        {
            DataReceivedEventHandler onLine = (s, e) => { if (!string.IsNullOrEmpty(e.Data)) Log("  " + Clean(e.Data)); };
            p.OutputDataReceived += onLine;
            p.ErrorDataReceived += onLine;
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            p.WaitForExit(); // flushes the async readers
            return p.ExitCode;
        }
    }

    /** Drops terminal colour codes and progress spinners. */
    static string Clean(string s)
    {
        s = Regex.Replace(s, @"\x1b\[[0-9;]*[A-Za-z]", "");
        int cr = s.LastIndexOf('\r');
        return cr >= 0 ? s.Substring(cr + 1) : s;
    }

    public static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        return "\"" + a.Replace("\\\"", "\\\\\"").Replace("\"", "\\\"") + (a.EndsWith("\\") ? "\\" : "") + "\"";
    }

    static string[] Concat(string[] a, string[] b)
    {
        var l = new List<string>(a);
        l.AddRange(b);
        return l.ToArray();
    }
}

// ======================================================================================
// Settings → Apps registration and uninstalling.
// ======================================================================================

class Uninstaller
{
    public const string ExeName = "Uninstall Mediarr.exe";
    const string AppsKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mediarr";
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";

    readonly SetupForm ui;
    readonly int waitPid;
    public Uninstaller(SetupForm ui, int waitPid) { this.ui = ui; this.waitPid = waitPid; }

    public static bool IsMediarrCopy(string dir)
    {
        try
        {
            string pkg = Path.Combine(dir, "package.json");
            return File.Exists(pkg) && Regex.IsMatch(File.ReadAllText(pkg), "\"name\"\\s*:\\s*\"mediarr\"");
        }
        catch { return false; }
    }

    /** The Mediarr folder to remove: --dir, or the folder this uninstaller sits in. */
    public static string TargetDir(Options o)
    {
        return Path.GetFullPath(o.Dir ?? Path.GetDirectoryName(Application.ExecutablePath));
    }

    public static string[] ShortcutPaths()
    {
        return new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Mediarr.lnk"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Mediarr.lnk"),
        };
    }

    /** Adds Mediarr to Settings → Apps / Control Panel → Programs (for this Windows user; no admin needed). */
    public static void Register(string dir, string uninstaller)
    {
        string version = null;
        try
        {
            Match m = Regex.Match(File.ReadAllText(Path.Combine(dir, "package.json")), "\"version\"\\s*:\\s*\"([^\"]+)\"");
            if (m.Success) version = m.Groups[1].Value;
        }
        catch { }
        using (var k = Registry.CurrentUser.CreateSubKey(AppsKey))
        {
            k.SetValue("DisplayName", "Mediarr");
            if (version != null) k.SetValue("DisplayVersion", version);
            k.SetValue("Publisher", "Mediarr");
            k.SetValue("DisplayIcon", uninstaller + ",0");
            k.SetValue("InstallLocation", dir);
            k.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd"));
            k.SetValue("UninstallString", "\"" + uninstaller + "\" --uninstall");
            k.SetValue("QuietUninstallString", "\"" + uninstaller + "\" --uninstall --quiet --keep-data");
            k.SetValue("URLInfoAbout", "https://github.com/Scrapper1824/Mediarr");
            k.SetValue("HelpLink", "https://github.com/Scrapper1824/Mediarr#readme");
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            try { k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, FolderBytes(dir) / 1024), RegistryValueKind.DWord); } catch { }
        }
    }

    static long FolderBytes(string dir)
    {
        long total = 0;
        foreach (string f in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            try { total += new FileInfo(f).Length; } catch { }
        return total;
    }

    /**
     * Windows can't delete a folder while a program inside it runs, so the uninstaller copies itself to
     * the temp folder and runs from there. Returns true when this process should just exit.
     */
    public static bool RelaunchOutsideFolder(Options o)
    {
        if (o.FromTemp) return false;
        string dir = TargetDir(o);
        string self = Path.GetFullPath(Application.ExecutablePath);
        if (!self.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return false;
        string copy = Path.Combine(Path.GetTempPath(), "MediarrUninstall-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".exe");
        File.Copy(self, copy, true);
        var args = new StringBuilder("--uninstall --from-temp --dir " + SetupForm.Quote(dir) + " --wait-pid " + Process.GetCurrentProcess().Id);
        if (o.Quiet) args.Append(" --quiet");
        if (o.KeepData) args.Append(" --keep-data");
        Process.Start(new ProcessStartInfo(copy, args.ToString()) { UseShellExecute = false });
        return true;
    }

    /** The temp copy removes itself a moment after it closes. */
    public static void DeleteSelfLater()
    {
        try
        {
            string self = Application.ExecutablePath;
            Process.Start(new ProcessStartInfo("cmd.exe", "/d /c ping 127.0.0.1 -n 3 > nul & del /f /q \"" + self + "\"")
            { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
        }
        catch { }
    }

    public string Run(string dir, bool deleteData)
    {
        if (!IsMediarrCopy(dir)) throw new Stop("\"" + dir + "\" doesn't look like a Mediarr folder, so nothing was removed.");
        ui.Log("Uninstalling Mediarr from " + dir);

        // The copy of this uninstaller in the Mediarr folder closes as soon as it has started this one.
        if (waitPid > 0) try { Process.GetProcessById(waitPid).WaitForExit(15000); } catch { }

        ui.Status("Stopping Mediarr…");
        StopProcesses(dir);

        ui.Status("Removing shortcuts and the start-with-Windows entry…");
        foreach (string lnk in ShortcutPaths())
        {
            try
            {
                if (File.Exists(lnk) && ShortcutPointsInto(lnk, dir)) { File.Delete(lnk); ui.Log("Removed " + lnk); }
            }
            catch (Exception ex) { ui.Log("Couldn't remove " + lnk + ": " + ex.Message); }
        }
        try
        {
            using (var run = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                var v = run != null ? run.GetValue("Mediarr") as string : null;
                if (v != null && v.IndexOf(dir, StringComparison.OrdinalIgnoreCase) >= 0) { run.DeleteValue("Mediarr", false); ui.Log("Mediarr no longer starts with Windows."); }
            }
        }
        catch (Exception ex) { ui.Log("Couldn't remove the start-with-Windows entry: " + ex.Message); }

        ui.Status(deleteData ? "Deleting Mediarr and its data…" : "Deleting Mediarr (keeping your data)…");
        string data = Path.Combine(dir, "data");
        var failed = new List<string>();
        for (int attempt = 0; attempt < 5; attempt++)
        {
            failed.Clear();
            foreach (string entry in Directory.Exists(dir) ? Directory.GetFileSystemEntries(dir) : new string[0])
            {
                if (!deleteData && string.Equals(entry, data, StringComparison.OrdinalIgnoreCase)) continue;
                try { DeleteTree(entry); } catch { failed.Add(entry); }
            }
            if (failed.Count == 0) break;
            Thread.Sleep(1500); // files can stay locked for a moment after Mediarr stops
        }
        if (deleteData && failed.Count == 0) try { Directory.Delete(dir, false); } catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(AppsKey, false); } catch { }

        if (failed.Count > 0)
            throw new Stop("Mediarr is uninstalled, but some files couldn't be deleted (something may still be using them):\n" + string.Join("\n", failed.ToArray()) + "\n\nDelete " + dir + " yourself after restarting.");
        ui.Status("Done.");
        return "Mediarr was removed from this PC." +
            (deleteData ? "" : "\n\nYour Mediarr data (settings, users, watch history) is still in " + data + ". Delete that folder if you don't need it; installing Mediarr into " + dir + " again picks it up.") +
            "\n\nYour movies, shows and anime weren't touched.";
    }

    /** Ends Mediarr's tray and server (and anything they started, like FFmpeg) that run from this folder. */
    void StopProcesses(string dir)
    {
        var procs = new List<Tuple<int, int, string, string>>(); // pid, parent, name, command line
        try
        {
            using (var s = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process"))
                foreach (ManagementObject p in s.Get())
                    procs.Add(Tuple.Create(Convert.ToInt32(p["ProcessId"]), Convert.ToInt32(p["ParentProcessId"]), (p["Name"] as string ?? "").ToLowerInvariant(), p["CommandLine"] as string ?? ""));
        }
        catch (Exception ex) { ui.Log("Couldn't list running programs: " + ex.Message); return; }

        int me = Process.GetCurrentProcess().Id;
        var kill = new List<int>();
        // The tray first (so it doesn't restart the server), then the server, then what the server started.
        foreach (string name in new[] { "powershell.exe", "pwsh.exe", "wscript.exe", "node.exe" })
            foreach (var p in procs)
                if (p.Item3 == name && p.Item1 != me && p.Item4.IndexOf(dir, StringComparison.OrdinalIgnoreCase) >= 0) kill.Add(p.Item1);
        for (int i = 0; i < kill.Count; i++)
            foreach (var p in procs)
                if (p.Item2 == kill[i] && !kill.Contains(p.Item1) && p.Item1 != me) kill.Add(p.Item1);
        foreach (int pid in kill)
        {
            try
            {
                var p = Process.GetProcessById(pid);
                ui.Log("Stopping " + p.ProcessName + " (" + pid + ")");
                p.Kill();
                p.WaitForExit(5000);
            }
            catch { }
        }
        if (kill.Count == 0) ui.Log("Mediarr wasn't running.");
    }

    static bool ShortcutPointsInto(string lnk, string dir)
    {
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(shellType);
        object l = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
        string args = l.GetType().InvokeMember("Arguments", BindingFlags.GetProperty, null, l, null) as string ?? "";
        string target = l.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, l, null) as string ?? "";
        return (args + " " + target).IndexOf(dir, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    /** Deletes a file or folder, including read-only files (Git marks its own files read-only). */
    static void DeleteTree(string path)
    {
        var attrs = File.GetAttributes(path);
        if ((attrs & FileAttributes.Directory) != 0 && (attrs & FileAttributes.ReparsePoint) == 0)
        {
            foreach (string e in Directory.GetFileSystemEntries(path)) DeleteTree(e);
            File.SetAttributes(path, FileAttributes.Normal);
            Directory.Delete(path, false);
        }
        else if ((attrs & FileAttributes.Directory) != 0)
        {
            Directory.Delete(path, false); // a link: remove the link, never what it points to
        }
        else
        {
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
        }
    }
}
