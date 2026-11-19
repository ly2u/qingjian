using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Qingjian
{
    public interface IRegistrationStore
    {
        void Set(string key, string name, object value, RegistryValueKind kind);
        object Get(string key, string name);
        void RemoveValue(string key, string name);
        void RemoveTree(string key);
        void RemoveIfEmpty(string key);
        string[] SubKeys(string key);
    }

    public sealed class UserRegistrationStore : IRegistrationStore
    {
        public void Set(string key, string name, object value, RegistryValueKind kind)
        { using (var entry = Registry.CurrentUser.CreateSubKey(key)) entry.SetValue(name, value, kind); }
        public object Get(string key, string name)
        { using (var entry = Registry.CurrentUser.OpenSubKey(key)) return entry == null ? null : entry.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames); }
        public void RemoveValue(string key, string name)
        { using (var entry = Registry.CurrentUser.OpenSubKey(key, true)) if (entry != null) entry.DeleteValue(name, false); }
        public void RemoveTree(string key) { Registry.CurrentUser.DeleteSubKeyTree(key, false); }
        public void RemoveIfEmpty(string key)
        {
            using (var entry = Registry.CurrentUser.OpenSubKey(key))
            { if (entry == null || entry.ValueCount != 0 || entry.SubKeyCount != 0) return; }
            Registry.CurrentUser.DeleteSubKey(key, false);
        }
        public string[] SubKeys(string key)
        { using (var entry = Registry.CurrentUser.OpenSubKey(key)) return entry == null ? new string[0] : entry.GetSubKeyNames(); }
    }

    public static class SystemIntegration
    {
        public const string ProgId = "Qingjian.Markdown";
        public const string Capabilities = @"Software\Qingjian\Capabilities";
        const string RegisteredApps = @"Software\RegisteredApplications";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Qingjian";
        const string Applications = @"Software\Classes\Applications";
        const string AppPaths = @"Software\Microsoft\Windows\CurrentVersion\App Paths";
        public static readonly string[] Extensions = { ".md", ".markdown", ".mdown" };
        [DllImport("shell32.dll")] static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);

        public static string OpenCommand(string exe) { return "\"" + Path.GetFullPath(exe) + "\" \"%1\""; }
        static string AppKey(string exe) { return @"Software\Classes\Applications\" + Path.GetFileName(exe); }
        static string AppPathKey(string exe) { return @"Software\Microsoft\Windows\CurrentVersion\App Paths\" + Path.GetFileName(exe); }
        static void Set(IRegistrationStore store, string key, string name, string value) { store.Set(key, name, value, RegistryValueKind.String); }

        static string[] OwnedAliases(IRegistrationStore store)
        {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string root in new[] { Applications, AppPaths })
                foreach (string name in store.SubKeys(root))
                    if (!String.IsNullOrEmpty(Convert.ToString(store.Get(root + "\\" + name, "QingjianExecutable")))) names.Add(name);
            return names.ToArray();
        }

        public static string RegisteredExecutable(IRegistrationStore store)
        {
            foreach (string key in new[] { Capabilities, @"Software\Classes\" + ProgId, UninstallKey })
            {
                string path = Convert.ToString(store.Get(key, "QingjianExecutable"));
                if (!String.IsNullOrEmpty(path)) return path;
            }
            foreach (string name in OwnedAliases(store))
                foreach (string root in new[] { Applications, AppPaths })
                {
                    string path = Convert.ToString(store.Get(root + "\\" + name, "QingjianExecutable"));
                    if (!String.IsNullOrEmpty(path)) return path;
                }
            return "";
        }

        public static void Register(IRegistrationStore store, string exe)
        {
            exe = Path.GetFullPath(exe);
            var aliases = new HashSet<string>(OwnedAliases(store), StringComparer.OrdinalIgnoreCase);
            aliases.Add(Path.GetFileName(exe));
            string command = OpenCommand(exe), icon = "\"" + exe + "\",0";
            string prog = @"Software\Classes\" + ProgId, app = AppKey(exe);
            Set(store, prog, "", "轻笺 Markdown 文档");
            Set(store, prog, "QingjianExecutable", exe);
            Set(store, prog, "FriendlyTypeName", "Markdown 文档");
            Set(store, prog + @"\DefaultIcon", "", icon);
            Set(store, prog + @"\shell\open\command", "", command);
            Set(store, prog + @"\Application", "ApplicationName", "轻笺");
            Set(store, prog + @"\Application", "ApplicationDescription", "离线 Markdown 编辑器，支持公式与图表");
            Set(store, prog + @"\Application", "ApplicationIcon", icon);
            Set(store, app, "FriendlyAppName", "轻笺");
            Set(store, app, "QingjianExecutable", exe);
            Set(store, app + @"\DefaultIcon", "", icon);
            Set(store, app + @"\shell\open\command", "", command);
            Set(store, Capabilities, "ApplicationName", "轻笺");
            Set(store, Capabilities, "ApplicationDescription", "轻量、离线的 Markdown 编辑器");
            Set(store, Capabilities, "ApplicationIcon", icon);
            Set(store, Capabilities, "QingjianExecutable", exe);
            Set(store, RegisteredApps, "Qingjian", Capabilities);
            foreach (string extension in Extensions)
            {
                Set(store, app + @"\SupportedTypes", extension, "");
                Set(store, Capabilities + @"\FileAssociations", extension, ProgId);
                store.Set(@"Software\Classes\" + extension + @"\OpenWithProgids", ProgId, new byte[0], RegistryValueKind.None);
                store.Set(@"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\" + extension + @"\OpenWithProgids", ProgId, new byte[0], RegistryValueKind.None);
            }
            Set(store, AppPathKey(exe), "", exe);
            Set(store, AppPathKey(exe), "QingjianExecutable", exe);
            // Preserve old application aliases so existing Windows defaults keep working.
            foreach (string name in aliases)
            {
                string alias = Applications + "\\" + name;
                Set(store, alias, "FriendlyAppName", "轻笺");
                Set(store, alias, "QingjianExecutable", exe);
                Set(store, alias + @"\DefaultIcon", "", icon);
                Set(store, alias + @"\shell\open\command", "", command);
                foreach (string extension in Extensions) Set(store, alias + @"\SupportedTypes", extension, "");
                if (String.Equals(name, Path.GetFileName(exe), StringComparison.OrdinalIgnoreCase)) store.RemoveValue(alias, "NoOpenWith");
                else Set(store, alias, "NoOpenWith", "");
                Set(store, AppPaths + "\\" + name, "", exe);
                Set(store, AppPaths + "\\" + name, "QingjianExecutable", exe);
            }
            Set(store, UninstallKey, "DisplayName", "轻笺（便携版系统注册）");
            Set(store, UninstallKey, "DisplayVersion", "0.3.2");
            Set(store, UninstallKey, "DisplayIcon", icon);
            Set(store, UninstallKey, "InstallLocation", Path.GetDirectoryName(exe));
            Set(store, UninstallKey, "UninstallString", "\"" + exe + "\" --unregister");
            Set(store, UninstallKey, "QuietUninstallString", "\"" + exe + "\" --unregister --quiet");
            Set(store, UninstallKey, "QingjianExecutable", exe);
            store.Set(UninstallKey, "NoModify", 1, RegistryValueKind.DWord);
            store.Set(UninstallKey, "NoRepair", 1, RegistryValueKind.DWord);
        }

        public static void Unregister(IRegistrationStore store, string exe)
        {
            exe = Path.GetFullPath(exe);
            string owner = RegisteredExecutable(store);
            if (!String.IsNullOrEmpty(owner) && !String.Equals(owner, exe, StringComparison.OrdinalIgnoreCase))
                throw new IOException("当前注册已属于另一位置的轻笺：\n" + owner + "\n旧版本无需卸载注册。请在当前注册的版本中移除。");
            var ownedKeys = new List<string> { @"Software\Classes\" + ProgId, AppKey(exe), AppPathKey(exe), UninstallKey, Capabilities };
            foreach (string name in OwnedAliases(store)) { ownedKeys.Add(Applications + "\\" + name); ownedKeys.Add(AppPaths + "\\" + name); }
            foreach (string extension in Extensions)
            {
                foreach (string key in new[] { @"Software\Classes\" + extension + @"\OpenWithProgids", @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\" + extension + @"\OpenWithProgids" })
                { store.RemoveValue(key, ProgId); store.RemoveIfEmpty(key); }
            }
            foreach (string key in ownedKeys.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                if (!String.IsNullOrEmpty(Convert.ToString(store.Get(key, "QingjianExecutable")))) store.RemoveTree(key);
            }
            if (String.Equals(Convert.ToString(store.Get(RegisteredApps, "Qingjian")), Capabilities, StringComparison.OrdinalIgnoreCase)) store.RemoveValue(RegisteredApps, "Qingjian");
            store.RemoveIfEmpty(@"Software\Qingjian");
        }

        public static Dictionary<string, object> Status(string exe)
        {
            var store = new UserRegistrationStore();
            string owner = RegisteredExecutable(store);
            return new Dictionary<string, object> { { "registered", !String.IsNullOrEmpty(owner) }, { "current", String.Equals(owner, Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase) }, { "executable", Path.GetFullPath(exe) }, { "registeredExecutable", owner } };
        }

        public static object Handle(string action)
        {
            string exe = Application.ExecutablePath;
            var store = new UserRegistrationStore();
            string previous = RegisteredExecutable(store);
            if (action == "register" || action == "defaults") Register(store, exe);
            else if (action == "unregister") Unregister(store, exe);
            else if (action != "status") throw new InvalidOperationException("不支持的系统集成操作。");
            if (action != "status") SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
            if (action == "defaults") Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=Qingjian") { UseShellExecute = true });
            var status = Status(exe);
            status["previousExecutable"] = previous;
            status["replacedPrevious"] = (action == "register" || action == "defaults") && !String.IsNullOrEmpty(previous) && !String.Equals(previous, exe, StringComparison.OrdinalIgnoreCase);
            return status;
        }

        public static bool RunCommand(string[] args)
        {
            string command = args.FirstOrDefault(arg => arg == "--register" || arg == "--unregister");
            if (command == null) return false;
            bool quiet = args.Contains("--quiet");
            try
            {
                var status = (Dictionary<string, object>)Handle(command == "--register" ? "register" : "unregister");
                if (!quiet) MessageBox.Show(command == "--register" ? ((bool)status["replacedPrevious"] ? "已将旧版注册自动替换为当前版本，无需先卸载。\n\n" : "已将轻笺加入 Markdown 的打开方式。\n\n") + Application.ExecutablePath + "\n\n首次使用时，可在 Windows 的“打开方式”中选择轻笺并设为默认。" : "已移除轻笺的系统注册。\n程序文件、文档、图片和草稿均保留。\n\n如果轻笺曾是默认应用，请为 .md 重新选择打开方式。", "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                Environment.ExitCode = 1;
                if (!quiet) MessageBox.Show("操作失败：" + ex.Message, "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            return true;
        }
    }
}
