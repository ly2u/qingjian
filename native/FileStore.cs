using System;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Qingjian
{
    public static class FileStore
    {
        public const long MaxFileSize = 16 * 1024 * 1024;

        public static Dictionary<string, object> Read(string path)
        {
            path = Path.GetFullPath(path);
            if (new FileInfo(path).Length > MaxFileSize)
                throw new IOException("这份文件超过 16 MB，请打开较小的文本文件。");
            byte[] bytes = File.ReadAllBytes(path);
            Encoding encoding;
            string label;
            int skip = 0;
            if (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf)
            { encoding = new UTF8Encoding(false, true); label = "UTF-8 BOM"; skip = 3; }
            else if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe)
            { encoding = Encoding.Unicode; label = "UTF-16 LE"; skip = 2; }
            else if (bytes.Length >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff)
            { encoding = Encoding.BigEndianUnicode; label = "UTF-16 BE"; skip = 2; }
            else
            {
                encoding = new UTF8Encoding(false, true); label = "UTF-8";
                try { encoding.GetString(bytes); }
                catch (DecoderFallbackException) { encoding = Encoding.GetEncoding(54936); label = "GB18030"; }
            }
            string content = encoding.GetString(bytes, skip, bytes.Length - skip);
            if (content.IndexOf('\0') >= 0) throw new IOException("这似乎不是文本文件，请选择 Markdown 或文本文件。");
            int lf = content.IndexOf('\n');
            string lineEnding = lf > 0 && content[lf - 1] == '\r' ? "CRLF" : "LF";
            content = content.Replace("\r\n", "\n").Replace("\r", "\n");
            return new Dictionary<string, object> {
                { "path", path }, { "name", Path.GetFileName(path) }, { "content", content },
                { "encoding", label }, { "lineEnding", lineEnding }, { "stamp", Stamp(path) }
            };
        }

        public static string Stamp(string path)
        {
            return File.Exists(path) ? File.GetLastWriteTimeUtc(path).Ticks.ToString() + ":" + new FileInfo(path).Length : null;
        }

        public static Encoding EncodingFor(string label)
        {
            switch (label) {
                case "UTF-8 BOM": return new UTF8Encoding(true);
                case "UTF-16 LE": return Encoding.Unicode;
                case "UTF-16 BE": return Encoding.BigEndianUnicode;
                case "GB18030": return Encoding.GetEncoding(54936);
                default: return new UTF8Encoding(false);
            }
        }

        public static void Write(string path, string content, string encoding, string lineEnding)
        {
            content = content.Replace("\r\n", "\n").Replace("\r", "\n");
            if (lineEnding == "CRLF") content = content.Replace("\n", "\r\n");
            Encoding targetEncoding = EncodingFor(encoding);
            if (targetEncoding.GetByteCount(content) + targetEncoding.GetPreamble().Length > MaxFileSize) throw new IOException("文件内容超过 16 MB，无法保存。");
            AtomicWrite(path, content, targetEncoding, null);
        }

        // Replace on the same volume so a failed write leaves the original intact.
        public static void AtomicWrite(string path, string text, Encoding encoding, string backupPath)
        {
            string temp = path + ".qingjian-" + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, encoding))
                {
                    writer.Write(text);
                    writer.Flush();
                    stream.Flush(true);
                }
                if (File.Exists(path)) File.Replace(temp, path, backupPath, true);
                else File.Move(temp, path);
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }

        public static bool IsMarkdown(string path)
        {
            string extension = Path.GetExtension(path).ToLowerInvariant();
            return extension == ".md" || extension == ".markdown" || extension == ".mdown" || extension == ".txt";
        }

        public static bool Within(string path, string directory)
        {
            string root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return Path.GetFullPath(path).StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }
    }
}
