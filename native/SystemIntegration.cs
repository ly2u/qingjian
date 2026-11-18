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
    }

    public static class SystemIntegration
    {
        public const string ProgId = "Qingjian.Markdown";
        public const string Capabilities = @"Software\Qingjian\Capabilities";
        const string RegisteredApps = @"Software\RegisteredApplications";
        const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Qingjian";
        public static readonly string[] Extensions = { ".md", ".markdown", ".mdown" };
        [DllImport("shell32.dll")] static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);

        public static string OpenCommand(string exe) { return "\"" + Path.GetFullPath(exe) + "\" \"%1\""; }
        static string AppKey(string exe) { return @"Software\Classes\Applications\" + Path.GetFileName(exe); }
        static string AppPathKey(string exe) { return @"Software\Microsoft\Windows\CurrentVersion\App Paths\" + Path.GetFileName(exe); }
        static void Set(IRegistrationStore store, string key, string name, string value) { store.Set(key, name, value, RegistryValueKind.String); }

        public static void Register(IRegistrationStore store, string exe)
        {
            exe = Path.GetFullPath(exe);
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
            Set(store, UninstallKey, "DisplayName", "轻笺（便携版系统注册）");
            Set(store, UninstallKey, "DisplayVersion", "0.2.0");
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
            string owner = Convert.ToString(store.Get(Capabilities, "QingjianExecutable"));
            if (!String.IsNullOrEmpty(owner) && !String.Equals(owner, exe, StringComparison.OrdinalIgnoreCase))
                throw new IOException("当前注册来自另一位置：\n" + owner + "\n请使用那份程序移除，或先在这里重新注册。");
            foreach (string extension in Extensions)
            {
                foreach (string key in new[] { @"Software\Classes\" + extension + @"\OpenWithProgids", @"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\" + extension + @"\OpenWithProgids" })
                { store.RemoveValue(key, ProgId); store.RemoveIfEmpty(key); }
            }
            foreach (string key in new[] { @"Software\Classes\" + ProgId, AppKey(exe), AppPathKey(exe), UninstallKey, Capabilities })
            {
                if (String.Equals(Convert.ToString(store.Get(key, "QingjianExecutable")), exe, StringComparison.OrdinalIgnoreCase)) store.RemoveTree(key);
            }
            if (String.Equals(Convert.ToString(store.Get(RegisteredApps, "Qingjian")), Capabilities, StringComparison.OrdinalIgnoreCase)) store.RemoveValue(RegisteredApps, "Qingjian");
            store.RemoveIfEmpty(@"Software\Qingjian");
        }

        public static object Status(string exe)
        {
            var store = new UserRegistrationStore();
            string owner = Convert.ToString(store.Get(Capabilities, "QingjianExecutable"));
            return new { registered = !String.IsNullOrEmpty(owner), current = String.Equals(owner, Path.GetFullPath(exe), StringComparison.OrdinalIgnoreCase), executable = Path.GetFullPath(exe), registeredExecutable = owner };
        }

        public static object Handle(string action)
        {
            string exe = Application.ExecutablePath;
            if (action == "register" || action == "defaults") Register(new UserRegistrationStore(), exe);
            else if (action == "unregister") Unregister(new UserRegistrationStore(), exe);
            else if (action != "status") throw new InvalidOperationException("不支持的系统集成操作。");
            if (action != "status") SHChangeNotify(0x08000000, 0, IntPtr.Zero, IntPtr.Zero);
            if (action == "defaults") Process.Start(new ProcessStartInfo("ms-settings:defaultapps?registeredAppUser=Qingjian") { UseShellExecute = true });
            return Status(exe);
        }

        public static bool RunCommand(string[] args)
        {
            string command = args.FirstOrDefault(arg => arg == "--register" || arg == "--unregister");
            if (command == null) return false;
            bool quiet = args.Contains("--quiet");
            try
            {
                Handle(command == "--register" ? "register" : "unregister");
                if (!quiet) MessageBox.Show(command == "--register" ? "已将轻笺加入 Markdown 的打开方式。\n\n右键 .md 文件 → 打开方式 → 选择其他应用 → 轻笺，\n再选择“始终使用”。\n\n也可以从轻笺的“更多 → Windows 文件关联”打开默认应用设置。" : "已移除轻笺的系统注册。\n程序文件、文档、图片和草稿均保留。\n\n如果轻笺曾是默认应用，请为 .md 重新选择打开方式。", "轻笺", MessageBoxButtons.OK, MessageBoxIcon.Information);
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
