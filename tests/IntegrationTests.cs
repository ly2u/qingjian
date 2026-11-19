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
    public string[] SubKeys(string key) { return Keys.Keys.Where(path => path.StartsWith(key + "\\", StringComparison.OrdinalIgnoreCase)).Select(path => path.Substring(key.Length + 1).Split('\\')[0]).Distinct(StringComparer.OrdinalIgnoreCase).ToArray(); }
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
        var upgrade = new MemoryRegistrationStore();
        string oldExe = Path.Combine(folder, "v0.2.0", "旧版轻笺.exe");
        string newExe = Path.Combine(folder, "v0.3.1", "轻笺.exe");
        const string oldApp = @"Software\Classes\Applications\旧版轻笺.exe";
        const string newApp = @"Software\Classes\Applications\轻笺.exe";
        SystemIntegration.Register(upgrade, oldExe);
        upgrade.Set(choice, "ProgId", @"Applications\旧版轻笺.exe", RegistryValueKind.String);
        upgrade.Set(choice, "Hash", "windows-protected-hash", RegistryValueKind.String);
        upgrade.Set(@"Software\Classes\Applications\OtherEditor.exe", "FriendlyAppName", "Other editor", RegistryValueKind.String);
        SystemIntegration.Register(upgrade, newExe);
        check(SystemIntegration.RegisteredExecutable(upgrade) == newExe, "new registration automatically replaces the old install path");
        check((string)upgrade.Get(@"Software\Classes\Qingjian.Markdown\shell\open\command", "") == SystemIntegration.OpenCommand(newExe), "stable Markdown handler points to the new executable");
        check((string)upgrade.Get(oldApp + @"\shell\open\command", "") == SystemIntegration.OpenCommand(newExe), "existing default application alias is redirected to the new version");
        check((string)upgrade.Get(@"Software\Microsoft\Windows\CurrentVersion\App Paths\旧版轻笺.exe", "") == newExe, "legacy app-path entry is updated instead of left stale");
        check(upgrade.Get(oldApp, "NoOpenWith") != null && upgrade.Get(newApp, "NoOpenWith") == null, "legacy aliases are hidden from duplicate open-with entries");
        check((string)upgrade.Get(choice, "ProgId") == @"Applications\旧版轻笺.exe" && (string)upgrade.Get(choice, "Hash") == "windows-protected-hash", "upgrade retains the user's existing Windows default and its hash");
        check((string)upgrade.Get(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Qingjian", "UninstallString") == "\"" + newExe + "\" --unregister", "the uninstall entry is migrated to the new version");
        check(((string)upgrade.Get(oldApp + @"\DefaultIcon", "")).Contains(newExe), "legacy file icons use the current executable");
        rejected = false;
        try { SystemIntegration.Unregister(upgrade, oldExe); } catch (IOException) { rejected = true; }
        check(rejected && SystemIntegration.RegisteredExecutable(upgrade) == newExe, "the old uninstaller cannot remove an upgraded registration");
        SystemIntegration.Unregister(upgrade, newExe);
        check(upgrade.Get(oldApp, "QingjianExecutable") == null && upgrade.Get(newApp, "QingjianExecutable") == null, "uninstalling the current registration cleans migrated aliases");
        check((string)upgrade.Get(@"Software\Classes\Applications\OtherEditor.exe", "FriendlyAppName") == "Other editor", "migration and removal leave other applications untouched");
        var partial = new MemoryRegistrationStore();
        SystemIntegration.Register(partial, oldExe);
        partial.RemoveTree(SystemIntegration.Capabilities);
        partial.RemoveTree(@"Software\Classes\Qingjian.Markdown");
        partial.RemoveTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Qingjian");
        check(SystemIntegration.RegisteredExecutable(partial) == oldExe, "old installations are discovered even if their capability entry is missing");
        SystemIntegration.Register(partial, newExe);
        check((string)partial.Get(oldApp + @"\shell\open\command", "") == SystemIntegration.OpenCommand(newExe), "partial old registration can be repaired and upgraded directly");
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
