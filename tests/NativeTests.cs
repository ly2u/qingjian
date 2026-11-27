using System;
using System.IO;
using System.Linq;
using System.Text;
using Qingjian;

class NativeTests
{
    static int checks;
    static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; Console.WriteLine("PASS " + name); }
    static void Main(string[] args)
    {
        try { Run(args); }
        catch (Exception error) { Console.Error.WriteLine(error.GetType().Name + ": " + error.Message); Environment.ExitCode = 1; }
    }
    static void Run(string[] args)
    {
        string folder = Path.GetFullPath(args[0]);
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, "encoding.md");
        const string sample = "# 中文\n这是内容 🌿\n第二行\n";
        foreach (string encoding in new[] { "UTF-8", "UTF-8 BOM", "UTF-16 LE", "UTF-16 BE" })
        {
            foreach (string eol in new[] { "LF", "CRLF" })
            {
                FileStore.Write(path, sample, encoding, eol);
                var read = FileStore.Read(path);
                Check((string)read["content"] == sample, encoding + "/" + eol + " text roundtrip");
                Check((string)read["encoding"] == encoding, encoding + "/" + eol + " encoding preserved");
                Check((string)read["lineEnding"] == eol, encoding + "/" + eol + " newline preserved");
            }
        }
        const string legacy = "传统中文编码测试\n";
        FileStore.Write(path, legacy, "GB18030", "CRLF");
        var legacyRead = FileStore.Read(path);
        Check((string)legacyRead["encoding"] == "GB18030" && (string)legacyRead["content"] == legacy, "GB18030 roundtrip");
        File.WriteAllText(path, "original", new UTF8Encoding(false));
        string backup = Path.Combine(folder, "backup.md");
        FileStore.AtomicWrite(path, "updated", new UTF8Encoding(false), backup);
        Check(File.ReadAllText(path) == "updated" && File.ReadAllText(backup) == "original", "atomic save preserves previous version in backup");
        string before = FileStore.Stamp(path);
        FileStore.Write(path, "external edit", "UTF-8", "LF");
        Check(FileStore.Stamp(path) != before, "external modification changes version stamp");
        bool rejected = false;
        File.SetAttributes(path, FileAttributes.ReadOnly);
        try { FileStore.Write(path, "must fail", "UTF-8", "LF"); } catch (UnauthorizedAccessException) { rejected = true; } catch (IOException) { rejected = true; }
        finally { File.SetAttributes(path, FileAttributes.Normal); }
        Check(rejected && File.ReadAllText(path) == "external edit", "failed save leaves original intact");
        Check(!Directory.EnumerateFiles(folder, "*.tmp").Any(), "temporary files are cleaned after failed save");
        Check(FileStore.Within(Path.Combine(folder, "assets", "a.png"), folder), "asset inside document root accepted");
        Check(!FileStore.Within(Path.Combine(folder, "..", "outside.md"), folder), "parent traversal rejected");
        Check(!FileStore.Within(folder + "-other\\test.md", folder), "directory prefix collision rejected");
        IntegrationTests.Run(Check, folder);
        SynchronizationTests.Run(Check, folder);
        Console.WriteLine(checks + " native checks passed.");
    }
}
