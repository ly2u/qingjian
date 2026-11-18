using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Microsoft.Win32;
using Qingjian;

public sealed class MemoryRegistrationStore : IRegistrationStore
{
    public readonly Dictionary<string, Dictionary<string, object>> Keys = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
    public void Set(string key, string name, object value, RegistryValueKind kind) { if (!Keys.ContainsKey(key)) Keys[key] = new Dictionary<string, object>(); Keys[key][name] = value; }
    public object Get(string key, string name) { object value; return Keys.ContainsKey(key) && Keys[key].TryGetValue(name, out value) ? value : null; }
    public void RemoveValue(string key, string name) { if (Keys.ContainsKey(key)) Keys[key].Remove(name); }
    public void RemoveTree(string key) { foreach (string path in Keys.Keys.Where(path => path == key || path.StartsWith(key + "\\", StringComparison.OrdinalIgnoreCase)).ToArray()) Keys.Remove(path); }
    public void RemoveIfEmpty(string key) { if (Keys.ContainsKey(key) && Keys[key].Count == 0 && !Keys.Keys.Any(path => path.StartsWith(key + "\\", StringComparison.OrdinalIgnoreCase))) Keys.Remove(key); }
}

public static class IntegrationTests
{
    public static void Run(Action<bool, string> check, string folder)
    {
        var store = new MemoryRegistrationStore();
        string exe = Path.Combine(folder, "带空格的 轻笺", "轻笺.exe");
        const string other = @"Software\Classes\.md\OpenWithProgids";
        const string choice = @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.md\UserChoice";
        store.Set(other, "Other.Editor", new byte[0], RegistryValueKind.None);
        store.Set(choice, "ProgId", "Other.Editor", RegistryValueKind.String);
        store.Set(@"Software\Classes\.md", "", "Other.Editor", RegistryValueKind.String);
        SystemIntegration.Register(store, exe);
        check((string)store.Get(@"Software\Classes\Qingjian.Markdown\shell\open\command", "") == "\"" + exe + "\" \"%1\"", "open command quotes Unicode paths and filename argument");
        check(SystemIntegration.Extensions.All(extension => (string)store.Get(SystemIntegration.Capabilities + @"\FileAssociations", extension) == SystemIntegration.ProgId), "registers all Markdown extensions");
        check((string)store.Get(choice, "ProgId") == "Other.Editor", "registration preserves Windows UserChoice");
        check((string)store.Get(@"Software\Classes\.md", "") == "Other.Editor", "registration preserves existing extension default");
        SystemIntegration.Register(store, exe);
        SystemIntegration.Unregister(store, exe);
        check(store.Get(other, "Other.Editor") != null && store.Get(other, SystemIntegration.ProgId) == null, "unregister removes only its own OpenWith value");
        check((string)store.Get(choice, "ProgId") == "Other.Editor", "unregister preserves another editor's default");
        check(!store.Keys.Keys.Any(key => key.Contains("Qingjian") || key.Contains("轻笺.exe")), "unregister removes owned application and uninstall entries");
        SystemIntegration.Unregister(store, exe);
        check(store.Keys.Count == 4 && store.Get(other, "Other.Editor") != null, "repeated unregister is safe and preserves foreign keys");
        SystemIntegration.Register(store, exe);
        bool rejected = false;
        try { SystemIntegration.Unregister(store, Path.Combine(folder, "other", "轻笺.exe")); } catch (IOException) { rejected = true; }
        check(rejected && store.Get(SystemIntegration.Capabilities, "QingjianExecutable") != null, "another portable copy cannot unregister the current owner");
        // Real IPC test uses an isolated test profile; it does not launch a window.
        using (var received = new AutoResetEvent(false))
        using (var first = new SingleInstance(Path.Combine(folder, Guid.NewGuid().ToString("N"))))
        {
            string[] actual = null;
            first.Listen(values => { actual = values; received.Set(); });
            string[] expected = { Path.Combine(folder, "中文 空格.md"), Path.Combine(folder, "second.md") };
            first.Send(expected);
            check(received.WaitOne(5000) && actual.SequenceEqual(expected), "single-instance IPC preserves multiple Unicode file paths");
        }
    }
}
