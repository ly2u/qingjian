using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using Qingjian;

class SynchronizationTests
{
    static Dictionary<string, object> Sync(string path, string text, string baseline, bool write = false, string overwrite = null, bool recreate = false)
    { return FileSynchronization.Synchronize(path, text, baseline, write, overwrite, recreate); }
    static bool WaitFor(Func<bool> condition)
    {
        DateTime end = DateTime.UtcNow.AddSeconds(8);
        while (DateTime.UtcNow < end) { if (condition()) return true; Thread.Sleep(25); }
        return false;
    }
    public static void Run(Action<bool, string> check, string root)
    {
        string folder = Path.Combine(root, "synchronization-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, "自动同步.md");
        FileStore.Write(path, "base\n", "UTF-16 LE", "CRLF");
        DateTime originalTime = File.GetLastWriteTimeUtc(path);
        check((string)Sync(path, "base\n", "base\n", true)["kind"] == "current" && File.GetLastWriteTimeUtc(path) == originalTime, "unchanged documents are not rewritten");
        check((string)Sync(path, "local\n", "base\n")["kind"] == "unchanged" && (string)FileStore.Read(path)["content"] == "base\n", "read-only rechecks never flush pending edits");
        check((string)Sync(path, "local\n", "base\n", true)["kind"] == "saved", "bound documents autosave without a file dialog");
        var saved = FileStore.Read(path);
        check((string)saved["encoding"] == "UTF-16 LE" && (string)saved["lineEnding"] == "CRLF", "autosave preserves encoding and line endings");
        FileStore.Write(path, "remote\n", "UTF-8 BOM", "LF");
        check((string)Sync(path, "local\n", "local\n")["kind"] == "loaded", "clean documents load external revisions");
        check((string)Sync(path, "mine\n", "local\n", true)["kind"] == "conflict" && (string)FileStore.Read(path)["content"] == "remote\n", "divergent external edits are not silently overwritten");
        string remoteStamp = FileStore.Stamp(path);
        FileStore.Write(path, "remote two\n", "UTF-8 BOM", "LF");
        check((string)Sync(path, "mine\n", "local\n", true, remoteStamp)["kind"] == "conflict", "conflict resolution rejects an external version changed after review");
        check((string)Sync(path, "mine\n", "local\n", true, FileStore.Stamp(path))["kind"] == "saved", "explicitly reviewed local resolution saves successfully");
        check((string)Sync(path, "mine\n", "old\n")["kind"] == "current", "matching external content acknowledges already synchronized edits");
        FileStore.Write(path, "AAAA", "UTF-8", "LF");
        string before = FileStore.Stamp(path);
        DateTime timestamp = File.GetLastWriteTimeUtc(path);
        FileStore.Write(path, "BBBB", "UTF-8", "LF");
        File.SetLastWriteTimeUtc(path, timestamp);
        check(before != FileStore.Stamp(path), "content revisions detect equal-sized changes with preserved timestamps");
        bool prevented = false;
        try { FileStore.Write(path, "must not replace", "UTF-8", "LF", before); } catch (FileChangedException) { prevented = true; }
        check(prevented && File.ReadAllText(path) == "BBBB", "atomic replacement rechecks the revision after preparing the temporary file");
        check(!Directory.EnumerateFiles(folder, "*.tmp").Any(), "rejected conditional saves clean up temporary files");
        File.Delete(path);
        check((string)Sync(path, "draft", "BBBB", true)["kind"] == "missing" && !File.Exists(path), "autosave never recreates an externally deleted file silently");
        check((string)Sync(path, "draft", "BBBB", true, null, true)["kind"] == "saved" && File.ReadAllText(path) == "draft", "explicit recreation restores a missing document");
        FileStore.Write(path, "returned", "UTF-8", "LF");
        check((string)Sync(path, "draft", "BBBB", true, null, true)["kind"] == "conflict", "recreation cannot overwrite a file restored by a sync client");
        File.SetAttributes(path, FileAttributes.ReadOnly);
        bool failed = false;
        try { Sync(path, "draft", "returned", true); } catch (UnauthorizedAccessException) { failed = true; } catch (IOException) { failed = true; }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
        check(failed && File.ReadAllText(path) == "returned", "read-only files retain disk content on failed autosave");

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        object gate = new object();
        using (var watcher = new FileWatchService(paths => { lock (gate) foreach (string item in paths) seen.Add(item); }))
        {
            Action clear = () => { lock (gate) seen.Clear(); };
            Func<bool> changed = () => { lock (gate) return seen.Contains(path); };
            watcher.SetPaths(new[] { path });
            File.WriteAllText(path, "in place", new UTF8Encoding(false));
            check(WaitFor(changed), "watcher notices another editor writing in place"); clear();
            FileStore.Write(path, "atomic replacement", "UTF-8", "LF");
            check(WaitFor(changed), "watcher follows atomic sync-client replacements"); clear();
            File.Delete(path);
            check(WaitFor(changed), "watcher notices deletion without discarding the open document"); clear();
            FileStore.Write(path, "reappeared", "UTF-8", "LF");
            check(WaitFor(changed), "watcher follows a file reappearing at the same path"); clear();
            watcher.SetPaths(new string[0]);
            FileStore.Write(path, "closed", "UTF-8", "LF"); Thread.Sleep(650);
            check(!changed(), "closed documents release subscriptions and stop receiving file events");
            string late = Path.Combine(folder, "late-folder", "restored.md");
            watcher.SetPaths(new[] { late });
            Directory.CreateDirectory(Path.GetDirectoryName(late)); FileStore.Write(late, "restored", "UTF-8", "LF");
            check(WaitFor(() => { lock (gate) return seen.Contains(late); }), "fallback polling reconnects when a missing directory is restored");
        }
    }
}
