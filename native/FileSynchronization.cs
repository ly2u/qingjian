using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace Qingjian
{
    // Compare actual text as well as revisions: sync clients may preserve file timestamps.
    public static class FileSynchronization
    {
        static Dictionary<string, object> Result(string kind, Dictionary<string, object> file)
        {
            return new Dictionary<string, object> { { "kind", kind }, { "file", file } };
        }

        public static Dictionary<string, object> Synchronize(string path, string content, string baseline, bool write, string overwriteStamp, bool recreate, string encoding = "UTF-8", string lineEnding = "LF")
        {
            Dictionary<string, object> disk = null;
            for (int attempt = 0; attempt < 4; attempt++)
            {
                try { disk = FileStore.Read(path); break; }
                catch (FileNotFoundException) { if (attempt == 3) break; }
                catch (DirectoryNotFoundException) { if (attempt == 3) break; }
                catch (IOException) { if (attempt == 3) throw; }
                Thread.Sleep(80);
            }
            if (disk == null)
            {
                if (!recreate) return Result("missing", null);
                // Move without replacement: a sync client may have restored the file already.
                FileStore.Create(path, content, encoding, lineEnding);
                return Result("saved", FileStore.Read(path));
            }
            string text = (string)disk["content"];
            if (text == content) return Result("current", disk);
            if (!String.IsNullOrEmpty(overwriteStamp))
            {
                if (overwriteStamp != (string)disk["stamp"]) return Result("conflict", disk);
            }
            else if (recreate) return Result("conflict", disk);
            else if (content == baseline) return Result("loaded", disk);
            else if (text != baseline) return Result("conflict", disk);
            if (!write) return Result("unchanged", disk);

            // Recheck immediately before replacement; never silently overwrite a divergent revision.
            if ((string)disk["stamp"] != FileStore.Stamp(path)) return Result("conflict", FileStore.Read(path));
            try { FileStore.Write(path, content, (string)disk["encoding"], (string)disk["lineEnding"], (string)disk["stamp"]); }
            catch (FileChangedException) { return File.Exists(path) ? Result("conflict", FileStore.Read(path)) : Result("missing", null); }
            disk = FileStore.Read(path);
            return Result((string)disk["content"] == content ? "saved" : "conflict", disk);
        }
    }

    // One watcher per open directory, with metadata polling as a fallback for missed events.
    // Notifications contain paths only. The UI serializes fresh reads with its own saves.
    public sealed class FileWatchService : IDisposable
    {
        readonly object gate = new object();
        readonly Action<string[]> changed;
        readonly Dictionary<string, FileSystemWatcher> watchers = new Dictionary<string, FileSystemWatcher>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, string> versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> pending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        readonly Timer debounce, poll;
        bool disposed;

        public FileWatchService(Action<string[]> changed)
        {
            this.changed = changed;
            debounce = new Timer(Deliver, null, Timeout.Infinite, Timeout.Infinite);
            poll = new Timer(Poll, null, 3000, 3000);
        }

        static string Version(string path)
        {
            try { var info = new FileInfo(path); return info.Exists ? info.LastWriteTimeUtc.Ticks + ":" + info.Length + ":" + info.Attributes : "missing"; }
            catch { return "unavailable"; }
        }

        public void SetPaths(IEnumerable<string> paths)
        {
            lock (gate)
            {
                if (disposed) return;
                var desired = new HashSet<string>(paths.Select(Path.GetFullPath), StringComparer.OrdinalIgnoreCase);
                foreach (string path in versions.Keys.Where(p => !desired.Contains(p)).ToArray()) { versions.Remove(path); pending.Remove(path); }
                foreach (string path in desired) if (!versions.ContainsKey(path)) versions[path] = Version(path);
                UpdateWatchers();
            }
        }

        void UpdateWatchers()
        {
            var directories = new HashSet<string>(versions.Keys.Select(Path.GetDirectoryName), StringComparer.OrdinalIgnoreCase);
            foreach (string folder in watchers.Keys.Where(p => !directories.Contains(p) || !Directory.Exists(p)).ToArray()) { watchers[folder].Dispose(); watchers.Remove(folder); }
            foreach (string folder in directories)
            {
                if (watchers.ContainsKey(folder) || !Directory.Exists(folder)) continue;
                try
                {
                    var watcher = new FileSystemWatcher(folder) { NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.Attributes, IncludeSubdirectories = false };
                    watcher.Changed += OnChange; watcher.Created += OnChange; watcher.Deleted += OnChange;
                    watcher.Renamed += delegate(object sender, RenamedEventArgs e) { Queue(e.OldFullPath); Queue(e.FullPath); };
                    watcher.Error += delegate { RecheckAll(); };
                    watcher.EnableRaisingEvents = true;
                    watchers[folder] = watcher;
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                catch (ArgumentException) { }
                catch (System.ComponentModel.Win32Exception) { }
                catch (System.Security.SecurityException) { }
            }
        }

        void OnChange(object sender, FileSystemEventArgs e) { Queue(e.FullPath); }
        void Queue(string path)
        {
            lock (gate)
            {
                if (disposed || !versions.ContainsKey(path)) return;
                pending.Add(path);
                debounce.Change(300, Timeout.Infinite);
            }
        }
        public void RecheckAll()
        {
            lock (gate)
            {
                if (disposed) return;
                foreach (string path in versions.Keys) pending.Add(path);
                if (pending.Count > 0) debounce.Change(300, Timeout.Infinite);
            }
        }
        void Poll(object unused)
        {
            lock (gate)
            {
                if (disposed) return;
                UpdateWatchers();
                foreach (string path in versions.Keys.ToArray())
                {
                    string version = Version(path);
                    if (versions[path] != version) { versions[path] = version; pending.Add(path); }
                }
                if (pending.Count > 0) debounce.Change(300, Timeout.Infinite);
            }
        }
        void Deliver(object unused)
        {
            string[] paths;
            lock (gate)
            {
                if (disposed || pending.Count == 0) return;
                paths = pending.ToArray(); pending.Clear();
                foreach (string path in paths) versions[path] = Version(path);
            }
            changed(paths);
        }
        public void Dispose()
        {
            lock (gate)
            {
                if (disposed) return;
                disposed = true; debounce.Dispose(); poll.Dispose();
                foreach (var watcher in watchers.Values) watcher.Dispose();
                watchers.Clear(); versions.Clear(); pending.Clear();
            }
        }
    }
}
