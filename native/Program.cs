using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Reflection.AssemblyTitle("轻笺")]
[assembly: System.Reflection.AssemblyDescription("轻量 Markdown 编辑器")]
[assembly: System.Reflection.AssemblyVersion("0.4.2.0")]

namespace Qingjian
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [STAThread]
        static void Main(string[] args)
        {
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e) {
                MessageBox.Show(e.Exception.Message, "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            };
            if (SystemIntegration.RunCommand(args)) return;
            using (var instance = new SingleInstance(SingleInstance.ProfilePath(args)))
            {
                if (!instance.IsPrimary)
                {
                    try { instance.Send(args); }
                    catch (Exception ex) { MessageBox.Show("无法联系已打开的轻笺：" + ex.Message, "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Warning); Environment.ExitCode = 1; }
                    return;
                }
                using (var window = new EditorWindow(args))
                {
                    IntPtr handle = window.Handle;
                    instance.Listen(delegate(string[] incoming) { if (!window.IsDisposed) window.BeginInvoke(new Action(delegate { window.ReceiveFiles(incoming); })); });
                    Application.Run(window);
                }
            }
        }
    }

    public sealed class EditorWindow : Form
    {
        const string Origin = "https://app.qingjian.local";
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 128 * 1024 * 1024, RecursionLimit = 200 };
        readonly HashSet<string> knownPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly List<string> recent = new List<string>();
        readonly HashSet<string> mappedHosts = new HashSet<string>();
        readonly Dictionary<string, string> assetDirectories = new Dictionary<string, string>();
        readonly string profile;
        readonly List<string> startupFiles = new List<string>();
        readonly WebView2 web = new WebView2();
        readonly FileWatchService fileWatch;
        Dictionary<string, object> lastSession;
        string workspacePath;
        object workspace;
        bool ready, allowClose, closeRequested;

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        public EditorWindow(string[] args)
        {
            fileWatch = new FileWatchService(delegate(string[] paths) {
                try {
                    if (!IsDisposed && IsHandleCreated) BeginInvoke(new Action(delegate {
                        if (ready && !IsDisposed && web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { @event = "filesChanged", paths = paths }));
                    }));
                } catch (InvalidOperationException) { }
            });
            Text = "轻笺";
            BackColor = Color.FromArgb(243, 244, 239);
            MinimumSize = new Size(860, 590);
            Size screen = Screen.PrimaryScreen.WorkingArea.Size;
            Size = new Size(Math.Min(1440, screen.Width - 60), Math.Min(950, screen.Height - 60));
            StartPosition = FormStartPosition.CenterScreen;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            profile = SingleInstance.ProfilePath(args);
            foreach (string arg in args)
            {
                if (File.Exists(arg) && FileStore.IsMarkdown(arg)) startupFiles.Add(Path.GetFullPath(arg));
            }
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);
            Shown += async delegate { await Initialize(); };
            FormClosing += OnClosing;
            FormClosed += delegate { fileWatch.Dispose(); };
            Activated += delegate { if (ready) fileWatch.RecheckAll(); };
        }

        public void ReceiveFiles(string[] args)
        {
            var incoming = args.Where(path => File.Exists(path) && FileStore.IsMarkdown(path)).Select(Path.GetFullPath).ToList();
            if (!ready) startupFiles.AddRange(incoming);
            else
            {
                try { web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { @event = "openFiles", files = incoming.Select(ReadDocument).ToArray() })); }
                catch (Exception ex) { MessageBox.Show(this, "打开失败：" + ex.Message, "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            }
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        }

        static string TextValue(IDictionary<string, object> data, string key, string fallback = "")
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value != null ? Convert.ToString(value) : fallback;
        }

        static bool BoolValue(IDictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) && value is bool && (bool)value;
        }

        static Dictionary<string, object> ObjectValue(IDictionary<string, object> data, string key)
        {
            object value;
            return data != null && data.TryGetValue(key, out value) ? value as Dictionary<string, object> : null;
        }

        async Task Initialize()
        {
            try
            {
                Directory.CreateDirectory(profile);
                LoadSession();
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(profile, "WebView2"));
                await web.EnsureCoreWebView2Async(environment);
                var core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsSwipeNavigationEnabled = false;
                core.Settings.IsBuiltInErrorPageEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.SetVirtualHostNameToFolderMapping("app.qingjian.local", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.DenyCors);
                core.WebMessageReceived += OnMessage;
                core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                    Uri uri;
                    if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri) || uri.GetLeftPart(UriPartial.Authority) != Origin) e.Cancel = true;
                };
                core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; };
                core.ProcessFailed += delegate { MessageBox.Show(this, "编辑界面意外退出。已保留的草稿可在重启后恢复。", "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Warning); };
                web.Source = new Uri(Origin + "/index.html");
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, "需要 Microsoft Edge WebView2 Runtime 才能运行。\n请从微软官方下载并安装 Evergreen Runtime：\nhttps://developer.microsoft.com/microsoft-edge/webview2/", "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Information);
                allowClose = true; Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "启动失败：" + ex.Message, "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Error);
                allowClose = true; Close();
            }
        }

        void LoadSession()
        {
            string stateFile = Path.Combine(profile, "state.json");
            foreach (string candidate in new[] { stateFile, Path.Combine(profile, "state.backup.json") })
            {
                try
                {
                    if (File.Exists(candidate)) { lastSession = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(candidate)); break; }
                }
                catch { /* Try the last successfully written backup. */ }
            }
            if (lastSession == null) lastSession = new Dictionary<string, object>();
            object paths;
            if (lastSession.TryGetValue("recent", out paths) && paths is IEnumerable)
                foreach (object item in (IEnumerable)paths)
                {
                    var path = item as string;
                    if (!String.IsNullOrEmpty(path) && File.Exists(path) && FileStore.IsMarkdown(path)) { knownPaths.Add(Path.GetFullPath(path)); recent.Add(path); }
                }
            object docs;
            if (lastSession.TryGetValue("documents", out docs) && docs is IEnumerable)
                foreach (object item in (IEnumerable)docs)
                {
                    var doc = item as Dictionary<string, object>;
                    string path = TextValue(doc, "path");
                    if (!String.IsNullOrEmpty(path) && FileStore.IsMarkdown(path)) knownPaths.Add(Path.GetFullPath(path));
                }
            string folder = TextValue(lastSession, "workspacePath");
            if (Directory.Exists(folder)) { workspacePath = folder; workspace = ScanWorkspace(folder); }
        }

        void Persist(Dictionary<string, object> session)
        {
            if (session == null) return;
            session["recent"] = recent.Take(15).ToArray();
            session["workspacePath"] = workspacePath;
            FileStore.AtomicWrite(Path.Combine(profile, "state.json"), json.Serialize(session), new UTF8Encoding(false), Path.Combine(profile, "state.backup.json"));
            lastSession = session;
        }

        void AddRecent(string path)
        {
            knownPaths.Add(Path.GetFullPath(path));
            recent.RemoveAll(p => String.Equals(p, path, StringComparison.OrdinalIgnoreCase));
            recent.Insert(0, path);
            if (recent.Count > 15) recent.RemoveRange(15, recent.Count - 15);
        }

        string RequireKnown(string path)
        {
            path = Path.GetFullPath(path);
            if (!knownPaths.Contains(path) || !FileStore.IsMarkdown(path)) throw new IOException("请先从打开对话框或文档列表选择文件。");
            return path;
        }

        Dictionary<string, object> ReadDocument(string path)
        {
            if (!FileStore.IsMarkdown(path)) throw new IOException("请选择 .md、.markdown、.mdown 或 .txt 文件。");
            var result = FileStore.Read(path);
            AddRecent(path);
            result["assetBase"] = MapAssets(path);
            result["recent"] = recent.ToArray();
            return result;
        }

        string MapAssets(string path)
        {
            if (String.IsNullOrEmpty(path)) return "";
            string directory = Path.GetDirectoryName(Path.GetFullPath(path));
            if (!Directory.Exists(directory)) return "";
            string documentDirectory = directory;
            if (workspacePath != null && FileStore.Within(path, workspacePath)) directory = workspacePath;
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(directory.ToLowerInvariant()))).Replace("-", "").Substring(0, 16).ToLowerInvariant();
            string host = "assets-" + hash + ".qingjian.local";
            if (mappedHosts.Add(host)) { web.CoreWebView2.SetVirtualHostNameToFolderMapping(host, directory, CoreWebView2HostResourceAccessKind.Allow); assetDirectories[host] = directory; }
            string relative = documentDirectory.Substring(directory.TrimEnd('\\').Length).Trim('\\');
            return "https://" + host + "/" + (relative.Length > 0 ? String.Join("/", relative.Split('\\').Select(Uri.EscapeDataString)) + "/" : "");
        }

        object ScanWorkspace(string folder)
        {
            var files = new List<Dictionary<string, object>>();
            var queue = new Queue<KeyValuePair<string, int>>();
            queue.Enqueue(new KeyValuePair<string, int>(folder, 0));
            var skipped = new HashSet<string>(new[] { ".git", ".obsidian", "node_modules", ".build", "$RECYCLE.BIN" }, StringComparer.OrdinalIgnoreCase);
            bool truncated = false;
            while (queue.Count > 0)
            {
                var entry = queue.Dequeue();
                try
                {
                    foreach (string path in Directory.EnumerateFiles(entry.Key).Where(FileStore.IsMarkdown).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
                    {
                        if (files.Count >= 3000) { truncated = true; break; }
                        knownPaths.Add(Path.GetFullPath(path));
                        files.Add(new Dictionary<string, object> { { "path", path }, { "name", Path.GetFileName(path) }, { "relative", path.Substring(folder.TrimEnd('\\').Length + 1) } });
                    }
                    if (truncated) break;
                    if (entry.Value < 8)
                        foreach (string directory in Directory.EnumerateDirectories(entry.Key))
                        {
                            var info = new DirectoryInfo(directory);
                            if (!skipped.Contains(info.Name) && (info.Attributes & (FileAttributes.Hidden | FileAttributes.ReparsePoint)) == 0)
                                queue.Enqueue(new KeyValuePair<string, int>(directory, entry.Value + 1));
                        }
                }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
            return new Dictionary<string, object> { { "name", new DirectoryInfo(folder).Name }, { "path", folder }, { "files", files }, { "truncated", truncated } };
        }

        Dictionary<string, object> SaveDocument(Dictionary<string, object> data, bool saveAs)
        {
            string path = TextValue(data, "path");
            bool sameFile = !saveAs && !String.IsNullOrEmpty(path);
            if (sameFile) path = RequireKnown(path);
            else
            {
                using (var dialog = new SaveFileDialog { Title = "保存 Markdown", Filter = "Markdown 文档 (*.md)|*.md|Markdown 文档 (*.markdown)|*.markdown|文本文件 (*.txt)|*.txt", FileName = TextValue(data, "name", "未命名.md"), DefaultExt = "md", AddExtension = true, OverwritePrompt = true })
                {
                    if (!String.IsNullOrEmpty(path)) dialog.InitialDirectory = Path.GetDirectoryName(path);
                    else if (!String.IsNullOrEmpty(workspacePath)) dialog.InitialDirectory = workspacePath;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                    path = dialog.FileName;
                }
            }
            if (!FileStore.IsMarkdown(path)) throw new IOException("请使用 .md、.markdown、.mdown 或 .txt 扩展名保存。");
            string stamp = TextValue(data, "stamp");
            if (sameFile && File.Exists(path) && stamp != FileStore.Stamp(path))
            {
                var answer = MessageBox.Show(this, "文件已被其他程序修改。\n仍要用当前内容覆盖吗？", "保存前确认", MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.Yes) return null;
            }
            FileStore.Write(path, TextValue(data, "content"), TextValue(data, "encoding", "UTF-8"), TextValue(data, "lineEnding", "LF"));
            var result = ReadDocument(path);
            return result;
        }

        async void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            Uri source;
            if (!Uri.TryCreate(e.Source, UriKind.Absolute, out source) || source.GetLeftPart(UriPartial.Authority) != Origin) return;
            object id = null;
            try
            {
                var message = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson);
                message.TryGetValue("id", out id);
                var data = ObjectValue(message, "params") ?? new Dictionary<string, object>();
                object result = null;
                switch (TextValue(message, "method"))
                {
                    case "init":
                        ready = true;
                        var opening = new List<Dictionary<string, object>>();
                        var openErrors = new List<string>();
                        foreach (string path in startupFiles)
                        {
                            try { opening.Add(ReadDocument(path)); }
                            catch (Exception error) { openErrors.Add(Path.GetFileName(path) + "：" + error.Message); }
                        }
                        result = new { session = lastSession, recent = recent.ToArray(), workspace = workspace, version = "0.4.2", filesToOpen = opening, openErrors = openErrors };
                        startupFiles.Clear();
                        break;
                    case "persist": Persist(data); result = true; break;
                    case "title":
                        Text = (BoolValue(data, "dirty") ? "● " : "") + TextValue(data, "name", "未命名.md") + " — 轻笺";
                        int dark = BoolValue(data, "dark") ? 1 : 0;
                        try { DwmSetWindowAttribute(Handle, 20, ref dark, 4); } catch { }
                        result = true; break;
                    case "openFile":
                        using (var dialog = new OpenFileDialog { Title = "打开 Markdown", Filter = "Markdown 和文本 (*.md;*.markdown;*.mdown;*.txt)|*.md;*.markdown;*.mdown;*.txt|所有文件 (*.*)|*.*", CheckFileExists = true })
                        { if (dialog.ShowDialog(this) == DialogResult.OK) result = ReadDocument(dialog.FileName); }
                        break;
                    case "openPath": result = ReadDocument(RequireKnown(TextValue(data, "path"))); break;
                    case "dropFile":
                        var dropped = e.AdditionalObjects.OfType<CoreWebView2File>().FirstOrDefault();
                        if (dropped == null) throw new IOException("无法读取拖入的文件，请使用“打开”。");
                        result = ReadDocument(dropped.Path); break;
                    case "saveFile": result = SaveDocument(data, BoolValue(data, "saveAs")); break;
                    case "watchFiles":
                        object watchPaths;
                        var watching = new List<string>();
                        if (data.TryGetValue("paths", out watchPaths) && watchPaths is IEnumerable)
                            foreach (object path in (IEnumerable)watchPaths) if (path is string) watching.Add(RequireKnown((string)path));
                        fileWatch.SetPaths(watching); result = true; break;
                    case "syncFile":
                        string syncPath = RequireKnown(TextValue(data, "path"));
                        result = await Task.Run(() => FileSynchronization.Synchronize(syncPath, TextValue(data, "content"), TextValue(data, "savedContent"), BoolValue(data, "write"), TextValue(data, "overwriteStamp"), BoolValue(data, "recreate"), TextValue(data, "encoding", "UTF-8"), TextValue(data, "lineEnding", "LF")));
                        break;
                    case "openFolder":
                        using (var dialog = new FolderBrowserDialog { Description = "选择存放 Markdown 的文件夹", ShowNewFolderButton = false, SelectedPath = workspacePath ?? "" })
                        { if (dialog.ShowDialog(this) == DialogResult.OK) { workspacePath = dialog.SelectedPath; workspace = ScanWorkspace(workspacePath); result = workspace; } }
                        break;
                    case "refreshFolder": if (Directory.Exists(workspacePath)) { workspace = ScanWorkspace(workspacePath); result = workspace; } break;
                    case "activateDocument": result = new { assetBase = String.IsNullOrEmpty(TextValue(data, "path")) ? "" : MapAssets(RequireKnown(TextValue(data, "path"))) }; break;
                    case "openLink":
                        string original = RequireKnown(TextValue(data, "path"));
                        string target = Uri.UnescapeDataString(TextValue(data, "target").Split('#')[0]);
                        string resolved = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(original), target.Replace('/', '\\')));
                        string root = workspacePath != null && FileStore.Within(original, workspacePath) ? workspacePath : Path.GetDirectoryName(original);
                        if (!FileStore.Within(resolved, root) || !FileStore.IsMarkdown(resolved)) throw new IOException("请通过“打开”选择这个本地文件。");
                        if (!File.Exists(resolved))
                        {
                            string candidate = knownPaths.FirstOrDefault(p => String.Equals(Path.GetFileName(p), Path.GetFileName(resolved), StringComparison.OrdinalIgnoreCase) && FileStore.Within(p, root));
                            if (candidate != null) resolved = candidate;
                        }
                        result = ReadDocument(resolved); break;
                    case "insertImage": result = InsertImage(data); break;
                    case "openExternal":
                        Uri external;
                        if (Uri.TryCreate(TextValue(data, "url"), UriKind.Absolute, out external) && (external.Scheme == "https" || external.Scheme == "http" || external.Scheme == "mailto")) Process.Start(new ProcessStartInfo(external.AbsoluteUri) { UseShellExecute = true });
                        result = true; break;
                    case "exportHtml":
                        using (var dialog = new SaveFileDialog { Title = "导出 HTML", Filter = "HTML 文档 (*.html)|*.html", FileName = TextValue(data, "name", "文档.html"), AddExtension = true, DefaultExt = "html" })
                        { if (dialog.ShowDialog(this) == DialogResult.OK) { FileStore.AtomicWrite(dialog.FileName, EmbedExportImages(TextValue(data, "html")), new UTF8Encoding(false), null); result = true; } }
                        break;
                    case "print": web.CoreWebView2.ShowPrintUI(); result = true; break;
                    case "confirmClose": ConfirmClose(data); result = true; break;
                    case "cancelClose": closeRequested = false; result = true; break;
                    case "integration": result = SystemIntegration.Handle(TextValue(data, "action", "status")); break;
                    default: throw new InvalidOperationException("不支持的操作。");
                }
                web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { id = id, result = result }));
            }
            catch (Exception ex)
            {
                if (web.CoreWebView2 != null) web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { id = id, error = ex.Message }));
                closeRequested = false;
            }
            await Task.CompletedTask;
        }

        object InsertImage(Dictionary<string, object> data)
        {
            string documentPath = TextValue(data, "path");
            if (String.IsNullOrEmpty(documentPath)) throw new IOException("请先保存文档，再插入本地图片。");
            documentPath = RequireKnown(documentPath);
            using (var dialog = new OpenFileDialog { Title = "插入本地图片", Filter = "图片 (*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp)|*.png;*.jpg;*.jpeg;*.gif;*.webp;*.bmp" })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return null;
                if (new FileInfo(dialog.FileName).Length > 32 * 1024 * 1024) throw new IOException("请选择 32 MB 以内的图片。");
                string directory = Path.Combine(Path.GetDirectoryName(documentPath), "assets");
                Directory.CreateDirectory(directory);
                string hash;
                using (var stream = File.OpenRead(dialog.FileName))
                using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").Substring(0, 12).ToLowerInvariant();
                string name = "image-" + hash + Path.GetExtension(dialog.FileName).ToLowerInvariant();
                string destination = Path.Combine(directory, name);
                if (!File.Exists(destination)) File.Copy(dialog.FileName, destination);
                return new { relative = "assets/" + name, name = Path.GetFileNameWithoutExtension(dialog.FileName) };
            }
        }

        string EmbedExportImages(string markup)
        {
            return Regex.Replace(markup, "https://assets-[a-z0-9]+\\.qingjian\\.local/[^\\\"\\s<>]+", delegate(Match match) {
                Uri uri;
                string directory;
                if (!Uri.TryCreate(match.Value, UriKind.Absolute, out uri) || !assetDirectories.TryGetValue(uri.Host, out directory)) return match.Value;
                string file = Path.GetFullPath(Path.Combine(directory, Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/').Replace('/', '\\')));
                string extension = Path.GetExtension(file).ToLowerInvariant();
                string mime = extension == ".png" ? "image/png" : extension == ".gif" ? "image/gif" : extension == ".webp" ? "image/webp" : extension == ".bmp" ? "image/bmp" : extension == ".jpg" || extension == ".jpeg" ? "image/jpeg" : null;
                if (!FileStore.Within(file, directory) || mime == null || !File.Exists(file) || new FileInfo(file).Length > 32 * 1024 * 1024) return "";
                return "data:" + mime + ";base64," + Convert.ToBase64String(File.ReadAllBytes(file));
            });
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (allowClose || !ready) return;
            e.Cancel = true;
            if (closeRequested) return;
            closeRequested = true;
            web.CoreWebView2.PostWebMessageAsJson("{\"event\":\"closing\"}");
        }

        void ConfirmClose(Dictionary<string, object> session)
        {
            var dirty = new List<Dictionary<string, object>>();
            object documents;
            if (session.TryGetValue("documents", out documents) && documents is IEnumerable)
                foreach (object value in (IEnumerable)documents)
                {
                    var doc = value as Dictionary<string, object>;
                    if (doc != null && TextValue(doc, "content") != TextValue(doc, "savedContent")) dirty.Add(doc);
                }
            if (dirty.Count > 0)
            {
                var answer = MessageBox.Show(this, "有 " + dirty.Count + " 份文档尚未保存到文件。\n要在退出前逐一保存吗？\n\n选择“否”仍会保留本地草稿。", "退出轻笺", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
                if (answer == DialogResult.Cancel) { closeRequested = false; return; }
                if (answer == DialogResult.Yes)
                    foreach (var doc in dirty)
                    {
                        var saved = SaveDocument(doc, false);
                        if (saved == null) { closeRequested = false; return; }
                        foreach (var item in saved) doc[item.Key] = item.Value;
                        doc["savedContent"] = saved["content"];
                        web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { @event = "documentSaved", document = doc }));
                    }
            }
            Persist(session);
            allowClose = true;
            BeginInvoke(new Action(Close));
        }
    }
}
