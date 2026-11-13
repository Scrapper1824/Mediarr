// Mediarr Setup: asks where to install, checks for Node.js / Git / FFmpeg (offering to install any that
// are missing with winget), downloads the latest Mediarr release from GitHub, installs and builds it,
// adds shortcuts and starts it. Built with the C# compiler that ships with Windows (see build.ps1),
// so it runs on any Windows 10/11 PC without anything else installed.
//
// Command line (optional, for scripted installs):
//   MediarrSetup.exe --dir "D:\Mediarr" --no-shortcut --no-start --quiet
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Mediarr Setup")]
[assembly: AssemblyProduct("Mediarr")]
[assembly: AssemblyDescription("Installs Mediarr from GitHub")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

static class Program
{
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static void Main(string[] args)
    {
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new SetupForm(args));
    }
}

class SetupForm : Form
{
    const string Repo = "Scrapper1824/Mediarr";
    const string RepoUrl = "https://github.com/Scrapper1824/Mediarr.git";
    const int Port = 7979;
    static readonly Version MinNode = new Version(22, 13, 0);

    readonly TextBox folderBox = new TextBox();
    readonly Button browseButton = new Button();
    readonly CheckBox shortcutBox = new CheckBox();
    readonly CheckBox startBox = new CheckBox();
    readonly TextBox logBox = new TextBox();
    readonly ProgressBar progress = new ProgressBar();
    readonly Label statusLabel = new Label();
    readonly Button installButton = new Button();
    readonly Button closeButton = new Button();
    readonly bool quiet;
    bool running;
    bool finished;

    public SetupForm(string[] args)
    {
        string dir = null;
        bool noShortcut = false, noStart = false;
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i].ToLowerInvariant();
            if (a == "--dir" && i + 1 < args.Length) dir = args[++i];
            else if (a == "--no-shortcut") noShortcut = true;
            else if (a == "--no-start") noStart = true;
            else if (a == "--quiet") quiet = true;
        }

        Text = "Mediarr Setup";
        Font = new Font("Segoe UI", 9.5f);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(620, 470);
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

        var title = new Label { Text = "Install Mediarr", Font = new Font("Segoe UI Semibold", 16f), AutoSize = true, Location = new Point(20, 16) };
        var intro = new Label
        {
            Text = "Downloads the latest Mediarr from GitHub and sets it up on this PC. Mediarr keeps its settings and library database inside this folder, so choose one you can write to.",
            Location = new Point(22, 54), Size = new Size(580, 40),
        };
        var folderLabel = new Label { Text = "Install to:", AutoSize = true, Location = new Point(22, 104) };
        folderBox.Location = new Point(24, 126);
        folderBox.Size = new Size(470, 26);
        folderBox.Text = dir ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mediarr");
        browseButton.Text = "Browse…";
        browseButton.Location = new Point(502, 124);
        browseButton.Size = new Size(94, 30);
        browseButton.Click += delegate { Browse(); };

        shortcutBox.Text = "Add Mediarr to the Start menu and the desktop";
        shortcutBox.Checked = !noShortcut;
        shortcutBox.AutoSize = true;
        shortcutBox.Location = new Point(24, 166);
        startBox.Text = "Start Mediarr when setup finishes";
        startBox.Checked = !noStart;
        startBox.AutoSize = true;
        startBox.Location = new Point(24, 192);

        logBox.Multiline = true;
        logBox.ReadOnly = true;
        logBox.ScrollBars = ScrollBars.Vertical;
        logBox.Font = new Font("Consolas", 8.5f);
        logBox.BackColor = Color.FromArgb(246, 247, 249);
        logBox.Location = new Point(24, 228);
        logBox.Size = new Size(572, 150);

        statusLabel.Location = new Point(22, 386);
        statusLabel.Size = new Size(580, 22);
        statusLabel.Text = "Ready to install.";
        progress.Location = new Point(24, 410);
        progress.Size = new Size(360, 10);
        progress.Style = ProgressBarStyle.Marquee;
        progress.Visible = false;

        installButton.Text = "Install";
        installButton.Size = new Size(100, 32);
        installButton.Location = new Point(392, 424);
        installButton.Click += delegate { Start(); };
        closeButton.Text = "Cancel";
        closeButton.Size = new Size(100, 32);
        closeButton.Location = new Point(498, 424);
        closeButton.Click += delegate { Close(); };
        AcceptButton = installButton;

        Controls.AddRange(new Control[] { title, intro, folderLabel, folderBox, browseButton, shortcutBox, startBox, logBox, statusLabel, progress, installButton, closeButton });

        FormClosing += (s, e) =>
        {
            if (running && !finished && MessageBox.Show(this, "Setup is still running. Stop it?", Text, MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes)
                e.Cancel = true;
        };
        if (quiet) Shown += delegate { Start(); };
    }

    void Browse()
    {
        using (var dlg = new FolderBrowserDialog())
        {
            dlg.Description = "Choose where to install Mediarr. A \"Mediarr\" folder is made inside the one you pick.";
            dlg.ShowNewFolderButton = true;
            if (dlg.ShowDialog(this) != DialogResult.OK) return;
            string picked = dlg.SelectedPath;
            bool alreadyNamed = string.Equals(Path.GetFileName(picked.TrimEnd('\\')), "Mediarr", StringComparison.OrdinalIgnoreCase);
            folderBox.Text = alreadyNamed ? picked : Path.Combine(picked, "Mediarr");
        }
    }

    // ---------- UI helpers (safe from the worker thread) ----------

    /** Everything shown in the box is also kept in %TEMP%\MediarrSetup.log (for troubleshooting). */
    static readonly string LogFile = Path.Combine(Path.GetTempPath(), "MediarrSetup.log");
    static readonly object LogLock = new object();

    void Log(string line)
    {
        lock (LogLock) { try { File.AppendAllText(LogFile, DateTime.Now.ToString("HH:mm:ss ") + line + Environment.NewLine); } catch { } }
        if (InvokeRequired) { BeginInvoke(new Action<string>(LogToBox), line); return; }
        LogToBox(line);
    }

    void LogToBox(string line)
    {
        logBox.AppendText(line + Environment.NewLine);
    }

    void Status(string text)
    {
        if (InvokeRequired) { BeginInvoke(new Action<string>(Status), text); return; }
        statusLabel.Text = text;
        Log("== " + text);
    }

    bool Ask(string question, MessageBoxIcon icon)
    {
        if (InvokeRequired) return (bool)Invoke(new Func<string, MessageBoxIcon, bool>(Ask), question, icon);
        return MessageBox.Show(this, question, "Mediarr Setup", MessageBoxButtons.YesNo, icon) == DialogResult.Yes;
    }

    void Tell(string text, MessageBoxIcon icon)
    {
        if (InvokeRequired) { Invoke(new Action<string, MessageBoxIcon>(Tell), text, icon); return; }
        MessageBox.Show(this, text, "Mediarr Setup", MessageBoxButtons.OK, icon);
    }

    class Stop : Exception { public Stop(string m) : base(m) { } }

    // ---------- Install ----------

    void Start()
    {
        if (running) return;
        string dir;
        try { dir = Path.GetFullPath(Environment.ExpandEnvironmentVariables(folderBox.Text.Trim())); }
        catch { Tell("That isn't a valid folder path.", MessageBoxIcon.Warning); return; }

        running = true;
        folderBox.Enabled = browseButton.Enabled = shortcutBox.Enabled = startBox.Enabled = installButton.Enabled = false;
        progress.Visible = true;
        bool shortcuts = shortcutBox.Checked, startAfter = startBox.Checked;

        var worker = new Thread(() =>
        {
            string error = null;
            string done = null;
            try { done = Install(dir, shortcuts, startAfter); }
            catch (Stop s) { error = s.Message; }
            catch (Exception ex) { error = "Setup stopped: " + ex.Message; }
            BeginInvoke(new Action(() => Finish(error, done)));
        });
        worker.IsBackground = true;
        worker.Start();
    }

    void Finish(string error, string done)
    {
        finished = true;
        progress.Visible = false;
        closeButton.Text = "Close";
        if (error != null)
        {
            statusLabel.Text = "Setup didn't finish.";
            Log("!! " + error);
            installButton.Text = "Try again";
            installButton.Enabled = folderBox.Enabled = browseButton.Enabled = shortcutBox.Enabled = startBox.Enabled = true;
            running = false;
            finished = false;
            if (!quiet) Tell(error + "\n\nThe full log is in " + LogFile + ".", MessageBoxIcon.Error);
            else Environment.ExitCode = 1;
        }
        else
        {
            statusLabel.Text = "Mediarr is installed.";
            if (!quiet) Tell(done, MessageBoxIcon.Information);
        }
        if (quiet) Close();
    }

    string Install(string dir, bool shortcuts, bool startAfter)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;

        // 1. Where: an empty (or new) folder, or an existing Mediarr copy to repair.
        bool existing = IsMediarrCopy(dir);
        if (!existing && Directory.Exists(dir) && Directory.GetFileSystemEntries(dir).Length > 0)
            throw new Stop("\"" + dir + "\" already has other files in it. Choose an empty folder, or a new one.");
        if (existing && !Ask("Mediarr is already installed in\n" + dir + "\n\nReinstall its packages and rebuild it? Your settings, users and library stay as they are.\n(To get a newer version, use Settings → System → Updates in Mediarr.)", MessageBoxIcon.Question))
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
            "Mediarr uses FFmpeg to play videos in the browser (converting them when needed), for thumbnails and to find intros. Everything else works without it, and you can install it later.",
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

        // 5. Shortcuts.
        string vbs = Path.Combine(dir, @"tray\Mediarr.vbs");
        if (shortcuts)
        {
            Status("Adding shortcuts…");
            try
            {
                string ico = Path.Combine(dir, @"installer\mediarr.ico");
                string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
                string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
                foreach (string where in new[] { programs, desktop })
                    MakeShortcut(Path.Combine(where, "Mediarr.lnk"), vbs, dir, File.Exists(ico) ? ico : null);
            }
            catch (Exception ex) { Log("Couldn't add shortcuts: " + ex.Message); }
        }

        // 6. Start.
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
                var psi = new ProcessStartInfo("wscript.exe", Quote(vbs)) { WorkingDirectory = dir, UseShellExecute = false };
                Process.Start(psi);
                bool up = false;
                for (int i = 0; i < 60 && !(up = PortAnswers()); i++) Thread.Sleep(1000);
                if (up)
                {
                    try { Process.Start(url); } catch { }
                    string codeFile = Path.Combine(dir, @"data\setup-code.txt");
                    string code = File.Exists(codeFile) ? File.ReadAllText(codeFile).Trim() : null;
                    started = "\n\nIt's running in the background (the orange M by the clock) and opening in your browser: " + url +
                        (string.IsNullOrEmpty(code) ? "" : "\n\nTo create your admin account, use this setup code: " + code + "\n(It's also in " + codeFile + ".)");
                }
                else
                {
                    started = "\n\nIt's starting in the background; open " + url + " in a minute. If it doesn't come up, right-click the orange M by the clock → Open log.";
                }
            }
        }

        Status("Done.");
        return "Mediarr is installed in\n" + dir + started +
            (shortcuts ? "\n\nStart it any time from the Start menu or the desktop shortcut." : "") +
            "\n\nUpdates appear inside Mediarr (Settings → System → Updates).";
    }

    // ---------- Dependencies ----------

    string EnsureNode()
    {
        string why = "Mediarr runs on Node.js (version " + MinNode.ToString(2) + "." + MinNode.Build + " or newer).";
        for (int attempt = 0; ; attempt++)
        {
            string node = FindExe("node.exe", new[] { @"%ProgramFiles%\nodejs\node.exe" });
            Version v = node != null ? NodeVersion(node) : null;
            if (v != null && v >= MinNode) { Log("Node.js " + v + " — " + node); return node; }
            if (attempt > 0)
                throw new Stop("Node.js " + MinNode.ToString(2) + "." + MinNode.Build + " or newer still isn't available" + (v != null ? " (found " + v + ")" : "") +
                    ". Install it from https://nodejs.org (the LTS version), then run Mediarr Setup again.");
            string have = v != null ? "You have Node.js " + v + ", which is too old." : "Node.js isn't installed.";
            if (!Ask(have + "\n\n" + why + "\n\nInstall the current Node.js LTS now?", MessageBoxIcon.Question))
                throw new Stop("Mediarr needs Node.js " + MinNode.ToString(2) + "." + MinNode.Build + " or newer. Install it from https://nodejs.org, then run Mediarr Setup again.");
            WingetInstall("OpenJS.NodeJS.LTS", "Node.js", "https://nodejs.org", v != null);
        }
    }

    string EnsureTool(string name, string exe, string wingetId, string page, bool required, string why, string[] extra)
    {
        string found = FindExe(exe, extra);
        if (found != null) { Log(name + " — " + found); return found; }
        string q = name + " isn't installed.\n\n" + why + "\n\nInstall " + name + " now?";
        if (!Ask(q, MessageBoxIcon.Question))
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
            if (Ask("Setup can't install " + name + " by itself on this PC (the Windows package manager, winget, isn't available).\n\nOpen the " + name + " download page instead?", MessageBoxIcon.Warning))
                try { Process.Start(page); } catch { }
            throw new Stop("Install " + name + ", then run Mediarr Setup again.");
        }
        Status("Installing " + name + " (Windows may ask for permission)…");
        var common = new[] { "--id", id, "--exact", "--source", "winget", "--accept-source-agreements", "--accept-package-agreements", "--silent", "--disable-interactivity" };
        int code = Run(winget, Concat(new[] { upgrade ? "upgrade" : "install" }, common), null, "Installing " + name, false);
        if (code != 0 && !upgrade) code = Run(winget, Concat(new[] { "upgrade" }, common), null, "Updating " + name, false);
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

    // ---------- Mediarr ----------

    static bool IsMediarrCopy(string dir)
    {
        try
        {
            string pkg = Path.Combine(dir, "package.json");
            return Directory.Exists(Path.Combine(dir, ".git")) && File.Exists(pkg) && Regex.IsMatch(File.ReadAllText(pkg), "\"name\"\\s*:\\s*\"mediarr\"");
        }
        catch { return false; }
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

    static bool PortAnswers()
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

    static void MakeShortcut(string lnkPath, string vbs, string dir, string ico)
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
        if (ico != null) set("IconLocation", ico + ",0");
        t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    // ---------- Running programs ----------

    void Run(string file, string[] args, string cwd, string label)
    {
        int code = Run(file, args, cwd, label, true);
        if (code != 0) throw new Stop(label + " failed (exit code " + code + "). The details are in the box above.");
    }

    int Run(string file, string[] args, string cwd, string label, bool _)
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

    static string Quote(string a)
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
